# 現在のビルドログと同じベースイメージを使用
FROM dunglas/frankenphp:php8.4.19-bookworm

# GDに必要なシステムライブラリをインストール
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
    && rm -rf /var/lib/apt/lists/*

# PHPのGD拡張をインストール・有効化
RUN docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) gd

# アプリケーションファイルをコピー
COPY . /app

# ポート設定（Railwayのデフォルト8080等に合わせる）
# ※もし Variables に PORT=8080 があるなら、そのまま動きます。