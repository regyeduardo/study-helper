"""Builds the phoneme model at image build time (spec 004, T002): facebook/wav2vec2-xlsr-53-espeak-cv-ft to ONNX, then int8
(dynamic quantization of the weights), with its vocabulary. No published int8 ONNX of it exists, so it is made here."""
import json
import sys
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from huggingface_hub import hf_hub_download
from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

NAME = 'facebook/wav2vec2-xlsr-53-espeak-cv-ft'
out = Path(sys.argv[1] if len(sys.argv) > 1 else '/model')
out.mkdir(parents=True, exist_ok=True)
model = Wav2Vec2ForCTC.from_pretrained(NAME).eval()
full = out / 'model-fp32.onnx'
torch.onnx.export(model, torch.zeros(1, 16000), str(full), input_names=['input_values'], output_names=['logits'],
                  dynamic_axes={'input_values': {0: 'batch', 1: 'samples'}, 'logits': {0: 'batch', 1: 'frames'}}, opset_version=17)
# only the MatMul weights, as the prototype the bench validated (the convolutions stay in fp32)
quantize_dynamic(str(full), str(out / 'model.onnx'), weight_type=QuantType.QUInt8, op_types_to_quantize=['MatMul'], per_channel=True)
full.unlink()
# the vocabulary straight from the model's file (its tokenizer would need eSpeak just to load)
(out / 'vocab.json').write_text(Path(hf_hub_download(NAME, 'vocab.json')).read_text())
Wav2Vec2FeatureExtractor.from_pretrained(NAME).to_json_file(str(out / 'preprocessor_config.json'))
print('modelo pronto em', out)
