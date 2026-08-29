#!/usr/bin/env bash

set -e

echo "==> dist を初期化します..."
rm -rf dist

echo "==> TypeScript をコンパイルします..."
npx tsc

echo "==> 静的ファイルをコピーします..."
mkdir -p dist/sidepanel

cp public/manifest.json dist/manifest.json
cp src/sidepanel/sidepanel.html dist/sidepanel/sidepanel.html
cp src/sidepanel/sidepanel.css dist/sidepanel/sidepanel.css

echo "==> ビルド完了"
