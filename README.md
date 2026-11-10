# WRAITH ENGLISH — структура

```
index.html        разметка (вход/регистрация, приложение)
css/styles.css    все стили
js/app.js         ядро: вход, чат (личные сообщения), разделы, админка
js/tracker.js     кнопка IELTS-трекера рядом с профилем + кнопка «Главное меню»
tracker.html      сам трекер (данные хранятся в браузере)
docs/             54 материала (Reading/Listening/Writing/…), грузятся только по клику
assets/           логотип
```

Загружай папку целиком на GitHub Pages (index.html должен лежать в корне).

## Вход через Google (админ rasvet1pro@gmail.com)
1. Google Cloud Console → Credentials → OAuth client (Web). Authorized redirect URI:
   `https://eesqqmqfeititqqxwvfl.supabase.co/auth/v1/callback`
2. Supabase → Authentication → Providers → Google: включить, вставить Client ID и Secret.
3. Supabase → Authentication → URL Configuration: Site URL и Redirect URLs = адрес твоего сайта на GitHub Pages.

Админ определяется по почте `rasvet1pro@gmail.com`, поэтому при входе через Google с этой почты все админ-функции работают.
Google блокирует вход внутри встроенных браузеров (в т.ч. Telegram Mini App) — там используй логин/пароль.
