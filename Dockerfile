FROM dunglas/frankenphp:php8.4.19-bookworm

# 1. GDのインストール（ここは成功しているので維持）
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
	&& rm -rf /var/lib/apt/lists/* \
	&& docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) gd

# 2. ファイルをコピー
COPY . /app
WORKDIR /app

# 3. 権限設定
RUN chown -R www-data:www-data /app

# 4. 実行コマンドを「PHP組み込みサーバー」に直撃させる
# 0.0.0.0（すべてのインターフェース）の8080番で、/appを公開
CMD ["php", "-S", "0.0.0.0:8080", "-t", "/app"]