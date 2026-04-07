FROM dunglas/frankenphp:php8.4.19-bookworm

# 1. GDのインストール（ここは成功していたのでそのまま）
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
	&& rm -rf /var/lib/apt/lists/* \
	&& docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) gd

# 2. ファイルのコピー
COPY . /app

# 3. Railwayの環境変数 PORT に対応させるための設定
# FrankenPHP(Caddy)にポートを教え、ドメイン制限を解除します
ENV SERVER_NAME=:8080
ENV CADDY_GLOBAL_OPTIONS="local_certs"

# 実行権限の付与（念のため）
RUN chown -R www-data:www-data /app

# 実行コマンド（FrankenPHPの標準起動）
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]