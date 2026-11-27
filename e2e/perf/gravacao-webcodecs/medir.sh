#!/bin/bash
# A gravação otimizada pelo WebCodecs (T174, research R18), com os módulos do app: a cena "apresentacao" de gravacao.mjs (slide a cada
# 20 s, câmera no canto, mouse 2 s a cada 15 s), 60 s, o ScreenCanvas decidindo os quadros, o CodecRecorder gravando e o makeSeekable
# no fim. Da raiz do repositório:
#   RUNNER=waterfox CASOS="wf-28:fonte=28 wf-14:fonte=14 wf-oculta:fonte=28&esconder=1" e2e/perf/gravacao-webcodecs/medir.sh
#   RUNNER=chromium CASOS="cr-28:fonte=28" e2e/perf/gravacao-webcodecs/medir.sh
# Precisa de xvfb-run, ffmpeg e do Waterfox ou Firefox (WATERFOX=caminho). Para cada caso: tamanho por hora (vídeo e som), quadros,
# duração e a nitidez do texto (SSIM da área do texto contra o slide desenhado) depois das trocas de slide.
# o laboratório com os módulos do app: RUNNER=waterfox|chromium, CASOS="nome:query ..."; tamanho, quadros, som, nitidez do texto
cd "$(dirname "$(readlink -f "$0")")"
../../../node_modules/.bin/esbuild codec-entry.ts --bundle --format=iife --global-name=App --outfile=app-codec.js --tsconfig=../../../tsconfig.json --log-level=warning || exit 1
CROP='crop=1400:640:120:240'
for spec in $CASOS; do
  nome=${spec%%:*}; query=${spec#*:}
  rm -f ff3-$nome.webm ref-$nome-*.png
  if [ "$RUNNER" = chromium ]; then timeout 160 node chromium.mjs "codec.html?nome=$nome&segundos=60&$query" > run-$nome.log 2>&1
  else WAIT=110 timeout 160 xvfb-run -a -s "-screen 0 1280x800x24" ./firefox.sh "codec.html?nome=$nome&segundos=60&$query" > run-$nome.log 2>&1; fi
  grep -E '"error"|visibility' run-$nome.log | cut -c1-200
  line=$(grep '"nome"' run-$nome.log)
  offset=$(echo "$line" | sed -E 's/.*"offset":([0-9.]+).*/\1/')
  video=$(ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 ff3-$nome.webm | awk '{t+=$1} END {print t}')
  audio=$(ffprobe -v error -select_streams a:0 -show_entries packet=size -of csv=p=0 ff3-$nome.webm | awk '{t+=$1} END {print t}')
  frames=$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 ff3-$nome.webm)
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ff3-$nome.webm)
  adur=$(ffprobe -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 ff3-$nome.webm | tail -1)
  errs=$(ffmpeg -v error -i ff3-$nome.webm -f null - 2>&1 | wc -l)
  total=$(stat -c %s ff3-$nome.webm)
  printf '%s: total %d MB/h (vídeo %d, som %d), %s quadros, duração %s s (som até %s s) | SSIM:' $nome $((total * 60 / 1000000)) $((video * 60 / 1000000)) $((audio * 60 / 1000000)) "$frames" "$dur" "$adur"
  for spec2 in 20.5:25 21:25 22:25 24:25 30:25 40.5:45 41:45 42:45 44:45 50:45 57:45; do
    t=${spec2%%:*}; ref=ref-$nome-${spec2##*:}.png
    at=$(python3 -c "print(max(0, $t - $offset))")
    ffmpeg -v error -y -ss $at -i ff3-$nome.webm -frames:v 1 frame-$nome-$t.png
    ssim=$(ffmpeg -i frame-$nome-$t.png -i $ref -lavfi "[0:v]$CROP[a];[1:v]$CROP[b];[a][b]ssim" -f null - 2>&1 | grep -o 'All:[0-9.]*' | cut -d: -f2)
    printf ' %s=%s' $t ${ssim:0:5}
  done
  echo
done
