"""Загружает файл в Cloudflare R2 (бакет referalka) и печатает публичный URL."""
import sys
from pathlib import Path

import boto3

R2_ACCESS_KEY = "a7debe388c020960f4b5e6facb6f4be2"
R2_SECRET_KEY = "3e15b43496ff681d095dd3b0f051532123986fd8f02837a7e834d10c88b8fc0a"
R2_BUCKET = "referalka"
R2_ENDPOINT = "https://304ee19dabcf43f29412ded44fd34580.r2.cloudflarestorage.com"
R2_PUBLIC_URL = "https://pub-519fc43b54e1489384397c9cea0c0ded.r2.dev"

if len(sys.argv) < 3:
    print("usage: upload_r2.py <local_file> <r2_key>")
    sys.exit(1)

local = Path(sys.argv[1])
key = sys.argv[2]

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    region_name="auto",
)

extra = {"ContentType": "text/plain; charset=utf-8"}
s3.upload_file(str(local), R2_BUCKET, key, ExtraArgs=extra)
print(f"{R2_PUBLIC_URL}/{key}")
