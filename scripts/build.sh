#!/usr/bin/env bash

set -e

echo "==> dist を初期化します..."
rm -rf dist

echo "==> TypeScript をコンパイルします..."
npx tsc

echo "==> 静的ファイルをコピーします..."
mkdir -p dist/popup

cp public/manifest.json dist/manifest.json
cp src/popup/popup.html dist/popup/popup.html
cp src/popup/popup.css dist/popup/popup.css

echo "==> ビルド完了"
