# Use official Python runtime
FROM python:3.11-slim

# Set the server's working directory
WORKDIR /app

# Copy the requirements file into the server
COPY requirements.txt .

# Install dependencies directly from the file
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your bot's code
COPY . .

# Start the bot
CMD ["python", "main.py"]
