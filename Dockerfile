FROM dunglas/frankenphp:php8.4.19-bookworm

# 1. GDのインストール（ここは成功実績があるので維持）
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

# 3. 実行権限の付与
RUN chown -R www-data:www-data /app

# 4. ポートとドメインの設定
# Railwayのポート（8080）で待ち受け、自動HTTPS（Caddyの機能）をオフにします
ENV SERVER_NAME=:8080
ENV CADDY_GLOBAL_OPTIONS="local_certs"

# 5. 標準の起動コマンド
# これにより、URLパスに応じたPHPファイル（index.php, img.php等）が実行されます
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]