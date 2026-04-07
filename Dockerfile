FROM dunglas/frankenphp:php8.4.19-bookworm

# 1. GDのインストール（ここは維持）
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
	&& rm -rf /var/lib/apt/lists/* \
	&& docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) gd

# 2. ファイルのコピー
COPY . /app

# 3. 実行権限
RUN chown -R www-data:www-data /app

# 4. 重要：Caddyの設定を「ファイルの実体優先」に強制
# SERVER_NAME を指定しつつ、ドキュメントルートを明示します
ENV SERVER_NAME=:8080
ENV FRANKENPHP_CONFIG="root /app"

# 念のため、以前作った info.php が残っていれば削除するか、
# 下記コマンドで「普通のPHPサーバー」として起動させます
CMD ["frankenphp", "php-server", "--port", "8080", "--root", "/app"]