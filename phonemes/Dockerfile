# Spec 004 (T002): the phoneme service, only on the internal network. The model is made in the first stage (torch is not shipped).
FROM python:3.12-slim AS model
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir transformers==4.46.3 onnx==1.17.0 onnxruntime==1.20.1
COPY export_model.py /export_model.py
RUN python /export_model.py /model

FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY --from=model /model /model
ENV PHONEMES_MODEL_DIR=/model PHONEMES_HOST=0.0.0.0
EXPOSE 8779
CMD ["python", "app.py", "--serve", "8779"]
