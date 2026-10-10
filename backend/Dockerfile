# EvenUp Python FastAPI Backend Dockerfile
FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered output
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies if required
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source and migrations
COPY app ./app
COPY migrations ./migrations

# Expose backend port
EXPOSE 8080

# Run FastAPI app via uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
