# Входной relay для Telegram webhook

Связано с [Telegram #51](https://github.com/sachkov-inside/inside-telegram/issues/51).
Этот вариант меняет только маршрут доставки webhook. Приложение, его база и
исходящий Telegram transport остаются на application host.

Telegram подключается по HTTPS к relay на TCP 88. `systemd-socket-proxyd` передаёт
неизменённый TLS поток на TCP 443 application host. Caddy предъявляет прежний
сертификат и проверяет маршруты, приложение проверяет webhook secret. Relay не
получает bot token, webhook secret или TLS private key. Это обычная TCP пересылка,
без Xray/VLESS и без завершения TLS на relay.

## Подготовка relay

Используйте доверенный Ubuntu host с `systemd-socket-proxyd`. Проверьте, что порт
88 свободен и имена двух units ещё не заняты. Существующие VPN, nginx и другие
службы не меняйте. Шаблоны находятся в `infra/production/webhook-relay/`.

Создайте `/etc/inside-webhook-relay/origin.env` с правами root:root 0600:

```dotenv
TELEGRAM_WEBHOOK_ORIGIN=<application IPv4>:443
```

Установите units в `/etc/systemd/system/` с правами root:root 0644. Перед запуском
выполните `systemd-analyze verify` для обоих файлов. На host с UFW разрешите TCP 88
только из актуальных опубликованных Telegram webhook ranges; проверьте порядок
правил и отсутствие более широкого разрешения для этого порта. На 7 сентября 2026
это `149.154.160.0/20` и `91.108.4.0/22`. Затем `systemctl daemon-reload` и
`systemctl enable --now inside-telegram-webhook-relay.socket`.

С самого relay проверьте TLS и ожидаемый отказ без secret, направив hostname бота
на loopback с помощью `curl --resolve <hostname>:88:127.0.0.1`. POST `{}` на
`https://<hostname>:88/webhooks/telegram` должен вернуть 401 с проверкой
сертификата, GET — 404. Не используйте `-k`. Это preflight, а не живая проверка
доставки Telegram. Проверьте также запрет TCP 88 из непредусмотренного источника.

## Переключение webhook

Сначала сохраните актуальный `getWebhookInfo` и точные hashes units/config в
защищённый operational record. Перед изменением повторно сравните URL, IP,
`allowed_updates` и `max_connections`: при чужом изменении остановитесь.

Через защищённый Bot API клиент на application host вызовите `setWebhook`:

- hostname и путь сохраняются, в HTTPS URL добавляется порт 88;
- `ip_address` указывает на relay IPv4; DNS hostname менять не нужно;
- `secret_token` берётся из текущей production-конфигурации и не меняется;
- `allowed_updates` и `max_connections` берутся из сверенного состояния;
- `drop_pending_updates=false` обязателен.

Не вызывайте `deleteWebhook`, `getUpdates` или сброс очереди. При timeout операции
сначала прочитайте фактический `getWebhookInfo`; не повторяйте изменение вслепую.
Проверьте новый exact URL/IP и сохранённые параметры. Старое соединение может
завершить уже начатый запрос: существующая дедупликация inbox по update ID
сохраняется.

## Живая проверка и восстановление

С разрешённого аккаунта отправьте несколько `/start`, в том числе после простоя
и после повторного установления соединения. Сопоставьте время отправки на клиенте,
`telegram_updates.received_at`, `processed_at` и `start_response_deliveries.delivered_at`.
Проверьте по одному ответу на команду, отсутствие растущей очереди и новых ошибок
webhook. Одна быстрая доставка не закрывает плавающий сбой.

Relay добавляет отдельную эксплуатационную зависимость. Контролируйте socket и
service, очередь `pending_update_count` и свежесть `last_error_date`. Ожидающие
события остаются у Telegram при отказе relay; service перезапускается после сбоя,
socket включается при загрузке host. Автоматического переключения маршрута нет.

Для отката сначала сверяйте, что webhook всё ещё указывает на этот relay. Верните
сохранённый URL/IP и прежние `allowed_updates`/`max_connections` через `setWebhook`,
с тем же secret и `drop_pending_updates=false`. Проверьте результат повторным
чтением. После восстановления маршрута остановите только эти service/socket и
удалите только добавленные для них firewall rules. Не удаляйте очередь или данные
бота. Возврат исходного маршрута может вернуть исходную сетевую задержку.

Источники: [Telegram webhook requirements](https://core.telegram.org/bots/webhooks),
[setWebhook](https://core.telegram.org/bots/api#setwebhook),
[systemd-socket-proxyd](https://www.freedesktop.org/software/systemd/man/latest/systemd-socket-proxyd.html).
