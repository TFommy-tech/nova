// server/proxy.js
// Прокси для стриминга аудио через наш сервер.
// Решает: CORS, неверный Content-Type, протухшие ссылки Invidious/YouTube.

const axios = require('axios');

function setupProxy(app) {
  /**
   * GET /api/stream?url=<encoded_url>
   * Стримит аудио с внешнего источника через наш сервер.
   * Поддерживает Range-запросы (перемотка в плеере).
   */
  app.get('/api/stream', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Разрешаем только http/https
    if (!/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
      };

      // Пробрасываем Range, чтобы работала перемотка
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      const response = await axios({
        method: 'GET',
        url: targetUrl,
        responseType: 'stream',
        headers,
        timeout: 30000,
        maxRedirects: 5,
        decompress: false,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      // Content-Type: если источник вернул мусор — принудительно audio/webm
      let contentType = response.headers['content-type'] || '';
      if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
        contentType = 'audio/webm';
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');

      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      if (response.headers['content-range']) {
        res.setHeader('Content-Range', response.headers['content-range']);
        res.status(206);
      } else {
        res.status(200);
      }

      // Стримим поток клиенту
      response.data.pipe(res);

      response.data.on('error', (err) => {
        console.error('[stream] pipe error:', err.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });

      // Если клиент отключился — рвём стрим с источника
      req.on('close', () => {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });

    } catch (error) {
      console.error('[stream] error:', error.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Stream error', details: error.message });
      }
    }
  });

  console.log('[proxy] /api/stream mounted');
}

module.exports = { setupProxy };
