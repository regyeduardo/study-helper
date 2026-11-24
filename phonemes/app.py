"""Reconhecedor de fonemas aberto (wav2vec2 XLSR-53 espeak, ONNX int8, CPU): prova de pronúncia som por som, de graça.

Como decide (sem IA julgando):
1. A frase esperada vira fonemas com o eSpeak, palavra por palavra. Cada som vira um "lugar" com o conjunto de pronúncias
   que um nativo usa ali (ex.: o "o" de long aceita ɔ e ɑ; vogal de palavra átona aceita qualquer vogal; t aceita o flap ɾ).
2. O modelo dá, quadro a quadro, a probabilidade de cada fonema. Com o alinhamento CTC, mede o quanto o áudio combina com a
   frase esperada.
3. Para cada som, testa o "concorrente" (o erro típico de quem fala português: θ→t, ɪ→iː, ʌ→ɑ…), a falta do som e um som a
   mais. Se o concorrente explica o áudio claramente melhor que o esperado (margem calibrada na bancada), aquele som saiu errado.

Rodar como serviço (o protótipo e, depois, o backend chamam por HTTP):  .venv-fonemas/bin/python phonemes.py --serve 8779
"""
import base64
import os
import io
import json
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
# the model made at build time (export_model.py); the prototype's own folder otherwise
MODEL_DIR = Path(os.environ.get('PHONEMES_MODEL_DIR') or (HERE / 'models' / 'xlsr53-int8'))
MODEL_NAME = 'facebook/wav2vec2-xlsr-53-espeak-cv-ft (ONNX int8)'
# Quanto (em nats) a versão com o erro precisa explicar o áudio melhor que a esperada para o som contar como errado.
# Calibrado na bancada (bench/FONEMAS.md): pior caso em 37 vozes nativas = troca 0,2 · faltou 0,4 · sobrou 1,4.
MARGINS = {'troca': 0.35, 'faltou': 0.7, 'sobrou': 2.0, 'palavra': 2.0}
SCALE = 1.0           # a bancada usa 0 para registrar tudo
GENERIC_FACTOR = 2.0  # idiomas sem regras próprias: mais exigente, para não acusar à toa
ESPEAK_VOICE = {'en': 'en-us', 'es': 'es', 'fr': 'fr-fr', 'de': 'de', 'it': 'it', 'pt': 'pt-br', 'ja': 'ja', 'zh': 'cmn', 'ko': 'ko', 'ru': 'ru', 'nl': 'nl'}

_lock = threading.Lock()
_state = {}


def _load():
    with _lock:
        if 'session' not in _state:
            so = ort.SessionOptions()
            so.intra_op_num_threads = 2
            so.inter_op_num_threads = 1
            _state['session'] = ort.InferenceSession(str(MODEL_DIR / 'model.onnx'), so, providers=['CPUExecutionProvider'])
            vocab = json.loads((MODEL_DIR / 'vocab.json').read_text())
            _state['vocab'] = vocab
            _state['ids'] = {i: t for t, i in vocab.items()}
            _state['backends'] = {}
    return _state


def _backend(lang):
    st = _load()
    voice = ESPEAK_VOICE.get(lang, lang)
    if voice not in st['backends']:
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        from phonemizer.backend import EspeakBackend
        st['backends'][voice] = EspeakBackend(voice, with_stress=True, preserve_punctuation=False)
    return st['backends'][voice]


# ---------- áudio e modelo ----------

def read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype={1: np.int8, 2: np.int16, 4: np.int32}[width]).astype(np.float32)
    a /= float(2 ** (8 * width - 1))
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != 16000:  # reamostra linear (o gravador do app já manda 16 kHz)
        n = int(len(a) * 16000 / rate)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


def logprobs(audio):
    st = _load()
    a = (audio - audio.mean()) / (audio.std() + 1e-7)
    logits = st['session'].run(None, {'input_values': a[None, :].astype(np.float32)})[0][0]
    m = logits.max(axis=-1, keepdims=True)
    return logits - m - np.log(np.exp(logits - m).sum(axis=-1, keepdims=True))


def greedy(lp):
    ids = _load()['ids']
    out, prev = [], -1
    for i in lp.argmax(-1):
        if i != prev and i > 3:
            out.append(ids[int(i)])
        prev = int(i)
    return out


# ---------- fonemas esperados ----------

VOWEL_CHARS = set('aeiouyæɐɑɒɔəɘɛɜɞɪɨʉʊʌɤɯøœɶɵʏᵻɚɝ')
FUNCTION_WORDS = set("""a an the to of and as at for can you your you're from that is are was were have has had do does but or than them some
his her him he she we me my be been will would should could i it in on by with so there their am its this these those us our""".split())


def is_vowel(tok):
    return any(c in VOWEL_CHARS for c in tok)


def _tokens(phone, vocab):
    """Uma unidade do eSpeak no alfabeto do modelo (divide quando o modelo não tem a unidade inteira)."""
    if phone in vocab:
        return [phone]
    out, i = [], 0
    while i < len(phone):
        for j in range(len(phone), i, -1):
            if phone[i:j] in vocab:
                out.append(phone[i:j]); i = j; break
        else:
            i += 1
    return out


def expected(text, lang):
    """[(palavra, [(fonema, tônica)])] da frase-alvo."""
    import re
    from phonemizer.separator import Separator
    vocab = _load()['vocab']
    words = [w for w in re.sub(r"[^\w' ]+", ' ', text.replace('’', "'")).split() if w]
    ph = _backend(lang).phonemize(words, separator=Separator(phone=' ', word='|', syllable=''), strip=True)
    out = []
    for w, p in zip(words, ph):
        phones = []
        for unit in p.split():
            stressed = 'ˈ' in unit or 'ˌ' in unit
            unit = unit.replace('ˈ', '').replace('ˌ', '')
            unit = unit.replace('|', '')
            if '\u0329' in unit:  # n̩ de wasn't: o nativo diz /ən/ ou /n̩/
                phones.append(('ə?', False))
                unit = unit.replace('\u0329', '')
            phones += [(t, stressed) for t in _tokens(unit, vocab)]
        if phones:
            out.append((w, phones))
    return out


# ---------- regras do inglês: o que um nativo aceita em cada lugar e o erro típico do brasileiro ----------

EN_VARIANTS = {
    'ɔ': {'ɔ', 'ɑ', 'ɑː', 'ɔː', 'ɒ', 'oː'}, 'ɔː': {'ɔː', 'ɔ', 'ɑː', 'ɑ', 'oː', 'ɒ'}, 'ɑː': {'ɑː', 'ɑ', 'a', 'aː', 'ɔ', 'ɒ', 'ɔː'},
    'ɑ': {'ɑː', 'ɑ', 'a', 'aː', 'ɔ', 'ɒ'}, 'æ': {'æ', 'a', 'aː', 'ɛ'}, 'ʌ': {'ʌ', 'ɐ', 'a', 'ə'}, 'ɪ': {'ɪ', 'ᵻ'},
    'iː': {'iː', 'i'}, 'i': {'i', 'iː', 'ɪ'}, 'ɛ': {'ɛ', 'e', 'ɛː', 'eː'}, 'eɪ': {'eɪ', 'e', 'eː'}, 'oʊ': {'oʊ', 'o', 'oː', 'əʊ', 'ɔ̃', 'õ'},
    'uː': {'uː', 'u'}, 'ʊ': {'ʊ', 'u'}, 'aɪ': {'aɪ', 'a', 'aɪə', 'aɪɚ'}, 'aʊ': {'aʊ', 'a'}, 'ɔɪ': {'ɔɪ', 'oɪ'},
    'ɜː': {'ɜː', 'ɚ', 'ɝ', 'əɜ'}, 'ɚ': {'ɚ', 'ə', 'ɜː', 'ɐ', 'ɹ'}, 'ʊɹ': {'ʊɹ', 'ɚ', 'uː', 'ʊ', 'oːɹ', 'ɔːɹ', 'ɔː', 'ɜː', 'oː'},
    'ɛɹ': {'ɛɹ', 'ɛ', 'eɪ', 'e', 'ɛː', 'eː'}, 'ɪɹ': {'ɪɹ', 'ɪ', 'iə', 'iː'}, 'ɑːɹ': {'ɑːɹ', 'ɑː', 'ɑ', 'a'},
    'ɔːɹ': {'ɔːɹ', 'ɔː', 'oːɹ', 'oː', 'ɔ'}, 'oːɹ': {'oːɹ', 'oː', 'ɔːɹ', 'ɔː'}, 'əl': {'əl', 'ʊ', 'l', 'o', 'ə', 'ɫ'}, 'aɪɚ': {'aɪɚ', 'aɪə', 'aɪ'},
    't': {'t', 'ɾ', 'ʔ', 'd'}, 'd': {'d', 'ɾ', 't'}, 'ɹ': {'ɹ', 'r', 'ɾ'}, 'l': {'l', 'ɫ', 'ɭ'}, 'z': {'z', 's'}, 's': {'s', 'z'},
}
# (sons concorrentes, como o app diz o que saiu): erros típicos de quem fala português
EN_CONFUSIONS = {
    'ɪ': [({'iː', 'i'}, 'iː')], 'iː': [({'ɪ', 'ᵻ'}, 'ɪ')], 'æ': [({'ɛ', 'e'}, 'ɛ')], 'ɛ': [({'æ'}, 'æ')],
    'ʌ': [({'ɑː', 'ɑ', 'ɔ', 'ɔː', 'ɒ'}, 'ɔ'), ({'oʊ', 'o', 'oː'}, 'oʊ')], 'ɔ': [({'ʌ', 'ɐ'}, 'ʌ'), ({'oʊ', 'o', 'oː'}, 'oʊ')],
    'ɑː': [({'ʌ', 'ɐ'}, 'ʌ'), ({'oʊ', 'o', 'oː'}, 'oʊ')], 'ɑ': [({'ʌ', 'ɐ'}, 'ʌ'), ({'oʊ', 'o', 'oː'}, 'oʊ')],
    'oʊ': [({'ɔ', 'ɑ', 'ɑː', 'ɒ'}, 'ɔ')], 'uː': [({'ʊ'}, 'ʊ')], 'ʊ': [({'uː', 'u'}, 'uː')], 'aɪ': [({'ɪ', 'iː', 'i'}, 'ɪ'), ({'eɪ', 'e'}, 'eɪ')],
    'eɪ': [({'ɛ'}, 'ɛ')], 'θ': [({'t'}, 't'), ({'f'}, 'f'), ({'s'}, 's')], 'ð': [({'d'}, 'd'), ({'z'}, 'z'), ({'v'}, 'v')],
    'ʃ': [({'s'}, 's'), ({'z'}, 'z'), ({'tʃ'}, 'tʃ')], 's': [({'ʃ'}, 'ʃ')], 'tʃ': [({'ʃ'}, 'ʃ')], 'dʒ': [({'ʒ'}, 'ʒ')],
    'v': [({'f'}, 'f'), ({'b'}, 'b')], 'ɹ': [({'h', 'x', 'χ'}, 'h')], 'ŋ': [({'n'}, 'n')],
}


class Slot:
    __slots__ = ('ids', 'optional', 'word', 'phone', 'stressed', 'fn', 'last_in_word')

    def __init__(self, ids, optional, word, phone, stressed, fn, last_in_word):
        self.ids, self.optional, self.word, self.phone, self.stressed, self.fn, self.last_in_word = ids, optional, word, phone, stressed, fn, last_in_word


def _ids(names):
    v = _load()['vocab']
    return frozenset(v[n] for n in names if n in v)


def slots_for(words, lang):
    v = _load()['vocab']
    all_vowels = frozenset(i for t, i in v.items() if i > 3 and is_vowel(t))
    english = lang == 'en'
    slots = []
    for wi, (word, phones) in enumerate(words):
        fn = word.lower() in FUNCTION_WORDS
        nxt = words[wi + 1][1][0][0] if wi + 1 < len(words) else None
        for pi, (ph, stressed) in enumerate(phones):
            last = pi == len(phones) - 1
            if ph == 'ə?':
                ids, ph = all_vowels, 'ə'
            elif english and is_vowel(ph) and (fn or not stressed):
                ids = all_vowels  # vogal átona ou de palavra gramatical: o nativo reduz (as → əz)
            elif english:
                ids = _ids(EN_VARIANTS.get(ph, {ph}))
            else:  # outros idiomas: só o som e a versão longa/curta dele
                ids = _ids({ph, ph.replace('ː', ''), ph + 'ː'})
            optional = phones[pi][0] == 'ə?'
            if english and last and ph in ('s', 'z') and nxt in ('ʃ', 'ʒ', 'j', 'tʃ'):
                optional = True  # assimilação: "this ship" → "thi‿ship" (o s se funde no sh)
            if english:
                # fala corrida: t/d no fim antes de consoante caem; n antes desse t/d vira nasal; h de palavra gramatical some
                if last and ph in ('t', 'd') and nxt and not is_vowel(nxt):
                    optional = True
                if ph == 'n' and pi + 1 < len(phones) and phones[pi + 1][0] in ('t', 'd') and pi + 2 == len(phones) and nxt and not is_vowel(nxt):
                    optional = True
                if fn and ph in ('h', 't', 'd', 'v') and (pi == 0 or last) and not (ph == 'h' and word.lower() in ('he', 'her', 'his', 'him', 'have', 'has', 'had') and wi == 0):
                    optional = True
                if fn and is_vowel(ph) and len(phones) > 1:
                    optional = True
            if ids:
                slots.append(Slot(ids, optional, wi, ph, stressed, fn, last))
    return slots


# ---------- alinhamento CTC por conjuntos ----------

def _lse(*xs):
    m = np.maximum.reduce(xs)
    m_safe = np.where(np.isfinite(m), m, 0.0)
    return np.where(np.isfinite(m), m_safe + np.log(sum(np.exp(x - m_safe) for x in xs)), -np.inf)


def ctc_score(lp, slots):
    """log P(áudio | sequência de lugares), com lugares opcionais (podem ser pulados)."""
    T, n = lp.shape[0], len(slots)
    if n == 0:
        return float(lp[:, 0].sum())
    S = 2 * n + 1
    probs = np.exp(lp)
    em = np.empty((T, S))
    em[:, 0::2] = lp[:, [0]]
    for k, s in enumerate(slots):
        em[:, 2 * k + 1] = np.log(probs[:, list(s.ids)].sum(axis=1) + 1e-12)
    # de onde cada estado pode vir (além de si mesmo e do anterior)
    skip2 = np.zeros(S, bool)
    for k in range(1, n):
        skip2[2 * k + 1] = slots[k].ids != slots[k - 1].ids
    skip4 = np.zeros(S, bool)  # pular um lugar opcional: do lugar k-2 (ou do branco depois dele) para o lugar k
    for k in range(2, n):
        if slots[k - 1].optional:
            skip4[2 * k + 1] = True
    a = np.full(S, -np.inf)
    a[0], a[1] = em[0, 0], em[0, 1]
    if slots[0].optional and n > 1:
        a[3] = em[0, 3]
    for t in range(1, T):
        prev1 = np.concatenate(([-np.inf], a[:-1]))
        prev2 = np.where(skip2, np.concatenate(([-np.inf, -np.inf], a[:-2])), -np.inf)
        prev3 = np.where(skip4, np.concatenate(([-np.inf] * 3, a[:-3])), -np.inf)
        prev4 = np.where(skip4, np.concatenate(([-np.inf] * 4, a[:-4])), -np.inf)
        new = _lse(a, prev1, prev2, prev3, prev4) + em[t]
        a = new
    ends = [a[S - 1], a[S - 2]]
    if slots[-1].optional and n > 1:
        ends += [a[S - 3], a[S - 4]]
    return float(np.logaddexp.reduce(ends))


def _with(slots, k, ids=None, drop=False, insert=None):
    out = list(slots)
    if drop:
        del out[k]
    elif insert is not None:
        out.insert(k, insert)
    else:
        s = out[k]
        out[k] = Slot(ids, False, s.word, s.phone, s.stressed, s.fn, s.last_in_word)
    return out


def score(wav_bytes, text, lang='en'):
    """Prova de pronúncia: quais sons saíram errados, em que palavra, e a dica em português."""
    t0 = time.time()
    lang = (lang or 'en').split('-')[0]
    st = _load()
    audio = read_wav(wav_bytes)
    lp = logprobs(audio)
    words = expected(text, lang)
    slots = slots_for(words, lang)
    base = ctc_score(lp, slots)
    english = lang == 'en'
    margin = {k: m * SCALE * (1.0 if english else GENERIC_FACTOR) for k, m in MARGINS.items()}
    v = st['vocab']
    all_vowels = frozenset(i for t, i in v.items() if i > 3 and is_vowel(t))
    issues = []
    for k, s in enumerate(slots):
        if s.fn and (is_vowel(s.phone) or s.optional):
            continue  # vogal de palavra gramatical: reduzir é o normal
        # 1. trocou por outro som (o erro típico)
        for comp, label in (EN_CONFUSIONS.get(s.phone, []) if english else []):
            cids = _ids(comp) - s.ids
            if cids:
                gain = ctc_score(lp, _with(slots, k, ids=cids)) - base
                if gain > margin['troca']:
                    issues.append({'word': words[s.word][0], 'expected': s.phone, 'heard': label, 'kind': 'troca', 'gain': round(gain, 2)})
        # 2. o som não saiu
        if not s.optional:
            gain = ctc_score(lp, _with(slots, k, drop=True)) - base
            if gain > margin['faltou']:
                issues.append({'word': words[s.word][0], 'expected': s.phone, 'heard': None, 'kind': 'faltou', 'gain': round(gain, 2)})
        # 3. vogal a mais depois do som (ex.: "big-i", "quit" virando "quiet")
        nxt_word_vowel = s.last_in_word and k + 1 < len(slots) and is_vowel(slots[k + 1].phone)
        if (not is_vowel(s.phone) or s.last_in_word) and not nxt_word_vowel and not s.fn:
            extra = Slot(all_vowels, False, s.word, '?', False, False, False)
            gain = ctc_score(lp, _with(slots, k + 1, insert=extra)) - base
            if gain > margin['sobrou']:
                issues.append({'word': words[s.word][0], 'expected': None, 'heard': 'vogal', 'kind': 'sobrou', 'after': s.phone, 'gain': round(gain, 2)})
    # palavra inteira que não saiu
    for wi, (w, _) in enumerate(words):
        rest = [s for s in slots if s.word != wi]
        if rest and not any(s.fn for s in slots if s.word == wi):
            gain = ctc_score(lp, rest) - base
            if gain > margin['palavra'] and not any(i['word'] == w for i in issues):
                issues.append({'word': w, 'expected': None, 'heard': None, 'kind': 'palavra', 'gain': round(gain, 2)})
    # um problema por palavra (o de maior diferença): os outros costumam ser eco do mesmo erro
    best = {}
    for i in issues:
        key = i['word'].lower()
        if key not in best or i['gain'] > best[key]['gain']:
            best[key] = i
    issues = sorted(best.values(), key=lambda i: -i['gain'])
    for i in issues:
        i['tip'] = tip(i)
    return {'ok': not issues, 'issues': issues, 'heard': ' '.join(greedy(lp)),
            'expected': ' | '.join(' '.join(p for p, _ in ph) for _, ph in words),
            'model': MODEL_NAME, 'secs': round(time.time() - t0, 2)}


# ---------- o retorno em português ----------

TIPS = {
    ('θ', 't'): 'o "th" saiu como "t". Ponha a ponta da língua entre os dentes e sopre, sem vibrar (um "s" com a língua para fora).',
    ('θ', 'f'): 'o "th" saiu como "f". Não use os lábios: a ponta da língua vai entre os dentes e o ar passa por ali.',
    ('θ', 's'): 'o "th" saiu como "s". Leve a ponta da língua até os dentes de cima, entre eles, e sopre.',
    ('ð', 'd'): 'o "th" saiu como "d". Língua entre os dentes, com a voz vibrando (um "z" com a língua para fora); não bata a língua como no "d".',
    ('ð', 'z'): 'o "th" saiu como "z". Mesmo som vibrado, mas com a ponta da língua entre os dentes.',
    ('ð', 'v'): 'o "th" saiu como "v". Sem os lábios: a ponta da língua entre os dentes, vibrando.',
    ('ɪ', 'iː'): 'o "i" curto saiu longo (ship virou sheep). É um "i" rápido e relaxado, quase um "ê" fechado; não estique nem sorria.',
    ('iː', 'ɪ'): 'o "i" longo saiu curto (sheep virou ship). Estique o "i" com os lábios esticados, como num sorriso: "iii".',
    ('æ', 'ɛ'): 'o "a" de "bad" saiu como "é". Abra mais a boca e baixe o queixo: um som entre "é" e "a".',
    ('ɛ', 'æ'): 'o "é" saiu aberto demais, como "a". Feche um pouco a boca: é o "é" de "pé".',
    ('ʌ', 'ɔ'): 'o "u" de "up/lung" saiu como o "ó/á" de "long". É um "â" curto e relaxado, como o "a" de "cama", sem arredondar os lábios.',
    ('ʌ', 'oʊ'): 'o "u" de "up/lung" saiu como "ôu". É um "â" curto e relaxado, como o "a" de "cama".',
    ('ɔ', 'ʌ'): 'o "o" de "long" saiu fechado, como "â" (lung). Abra a boca: um "á/ó" aberto e mais longo.',
    ('ɑː', 'ʌ'): 'o "a/o" aberto saiu fechado, como "â". Abra bem a boca: "á" longo.',
    ('ɑ', 'ʌ'): 'o "a/o" aberto saiu fechado, como "â". Abra bem a boca: "á" longo.',
    ('ɔ', 'oʊ'): 'o "ó" saiu como "ôu" (want virou won\'t). Mantenha a boca aberta, sem fechar para "u" no fim.',
    ('ɑ', 'oʊ'): 'o "á" saiu como "ôu" (want virou won\'t). Mantenha a boca aberta, sem fechar para "u" no fim.',
    ('ɑː', 'oʊ'): 'o "á" saiu como "ôu". Mantenha a boca aberta, sem fechar para "u" no fim.',
    ('oʊ', 'ɔ'): 'o "ôu" saiu como "ó/á" (won\'t virou want). Comece num "ô" e feche os lábios para um "u": "uôunt".',
    ('uː', 'ʊ'): 'o "u" longo saiu curto. Estique e arredonde os lábios: "uuu".',
    ('ʊ', 'uː'): 'o "u" curto saiu longo. É rápido e relaxado, quase um "ô" fechado.',
    ('aɪ', 'ɪ'): 'o "ai" saiu como "i". Abra a boca no "a" antes de fechar no "i": "ai".',
    ('aɪ', 'eɪ'): 'o "ai" saiu como "ei" (fine virou fain). Comece com a boca bem aberta, no "a": "fáin".',
    ('eɪ', 'ɛ'): 'o "ei" saiu como "é". Feche para um "i" no fim: "ei".',
    ('ʃ', 's'): 'o "sh" saiu como "s". É o "ch" de "chá": lábios para frente, língua mais para trás.',
    ('ʃ', 'z'): 'o "sh" saiu como "z". É o "ch" de "chá", sem vibrar a voz.',
    ('ʃ', 'tʃ'): 'o "sh" saiu como "tch". Sem a batida do "t": só o "ch" de "chá".',
    ('s', 'ʃ'): 'o "s" saiu como "ch". Língua atrás dos dentes de cima, lábios relaxados: "sss".',
    ('tʃ', 'ʃ'): 'o "ch" saiu sem a batida. É "tch", como em "tchau".',
    ('dʒ', 'ʒ'): 'o "j" saiu sem a batida. É "dj", como em "dia" no Rio.',
    ('v', 'f'): 'o "v" saiu como "f". Vibre a voz: dentes de cima no lábio de baixo, com som.',
    ('v', 'b'): 'o "v" saiu como "b". Encoste os dentes de cima no lábio de baixo, sem fechar a boca.',
    ('ɹ', 'h'): 'o "r" saiu como o "r" de "rato" (na garganta). O "r" inglês é com a língua curvada para trás, sem encostar no céu da boca.',
    ('ŋ', 'n'): 'o "ng" saiu como "n". Feche a parte de trás da língua no céu da boca, sem soltar um "g" no fim.',
}


def tip(i):
    w = i['word']
    if i['kind'] == 'troca':
        t = TIPS.get((i['expected'], i['heard']))
        return f'Em “{w}”, ' + (t or f'o som /{i["expected"]}/ saiu como /{i["heard"]}/.')
    if i['kind'] == 'faltou':
        if i['expected'] in ('t', 'd') :
            return f'Faltou o “{i["expected"]}” em “{w}”. Termine a palavra encostando a língua atrás dos dentes de cima.'
        if i['expected'] == 'h':
            return f'Faltou o “h” em “{w}”: é só um sopro, como um “rr” bem leve de “carro”.'
        return f'Faltou o som /{i["expected"]}/ em “{w}”.'
    if i['kind'] == 'sobrou':
        return f'Saiu uma vogal a mais em “{w}” (depois do /{i["after"]}/). Quem fala português põe um “i” no fim (“big-i”); termine na consoante.'
    return f'A palavra “{w}” não apareceu na sua fala.'


# ---------- serviço HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            _load()
            return self._json({'ok': True, 'model': MODEL_NAME})
        self._json({'error': 'not_found'}, 404)

    def do_POST(self):
        # /assess is the name of the contract (spec 004); /score is the prototype's
        if self.path not in ('/score', '/assess'):
            return self._json({'error': 'not_found'}, 404)
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 20_000_000)))
            res = score(base64.b64decode(body['audio']), body['text'], body.get('lang', 'en'))
            self._json(res)
        except Exception as e:
            self._json({'error': str(e)[:300]}, 400)

    def _json(self, body, code=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--serve':
        _load()
        _backend('en')
        host = os.environ.get('PHONEMES_HOST', '127.0.0.1')
        print(f'fonemas em http://{host}:{sys.argv[2]}', flush=True)
        ThreadingHTTPServer((host, int(sys.argv[2])), Handler).serve_forever()
    else:  # uso: phonemes.py arquivo.wav "frase" [idioma]
        print(json.dumps(score(Path(sys.argv[1]).read_bytes(), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'en'), ensure_ascii=False, indent=1))
