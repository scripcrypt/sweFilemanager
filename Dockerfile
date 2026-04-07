FROM dunglas/frankenphp:php8.4.19-bookworm

# 1. GDのインストール
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

# 4. ここが最重要：Railwayのポート8080で、HTTPのみで待機する設定
# SERVER_NAMEに「http://」を付け、ポートを指定します
ENV SERVER_NAME="http://:8080"
ENV FRANKENPHP_CONFIG="import /etc/caddy/Caddyfile"

# 5. 起動コマンド（デフォルトを尊重しつつポートを明示）
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]