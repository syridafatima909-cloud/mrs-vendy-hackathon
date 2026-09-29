FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
# SERVICE=ui (default) runs the Streamlit app; SERVICE=api runs the FastAPI server.
ENV SERVICE=ui PORT=8501
EXPOSE 8501 8000
CMD ["sh", "-c", "if [ \"$SERVICE\" = \"api\" ]; then uvicorn api.main:app --host 0.0.0.0 --port ${PORT}; else streamlit run app.py --server.address 0.0.0.0 --server.port ${PORT} --server.headless true; fi"]
