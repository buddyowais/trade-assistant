/* AI layer. Talks to free providers directly from the phone using YOUR keys.
   Groq / Gemini / OpenRouter have free tiers; Ollama is fully local and unlimited. */
(function (root) {
  const DEFAULTS = {
    groq: { label: 'Groq (free tier)', model: 'llama-3.3-70b-versatile', vision: 'meta-llama/llama-4-scout-17b-16e-instruct', url: 'https://api.groq.com/openai/v1/chat/completions', needsKey: true },
    gemini: { label: 'Google Gemini (free tier)', model: 'gemini-2.5-flash', vision: 'gemini-2.5-flash', needsKey: true },
    openrouter: { label: 'OpenRouter (free models)', model: 'meta-llama/llama-3.3-70b-instruct:free', vision: 'google/gemma-3-27b-it:free', url: 'https://openrouter.ai/api/v1/chat/completions', needsKey: true },
    ollama: { label: 'Ollama (local, unlimited)', model: 'qwen2.5:7b', vision: 'qwen2.5vl:7b', needsKey: false },
  };

  const SYSTEM = `You are a sharp, disciplined trading analyst built into the user's personal trading app.

RULES
1. Ground every claim in the DATA block provided (indicators, levels, structure, plan, news, journal stats). Quote the actual numbers. If the data does not support a claim, say so. Never invent prices, levels, news or statistics.
2. The numbers in DATA were computed by code and are exact. Do not recompute or contradict them. Your job is interpretation, prioritisation and clear communication.
3. Be decisive but honest. Give a bias (long / short / wait), the reasoning in order of importance, a concrete plan (entry zone, stop, targets, risk:reward) and exactly what would invalidate it. If timeframes conflict or the edge is weak, say "wait" and explain what you need to see.
4. Markets are uncertain. Express confidence honestly, never guarantee outcomes, and never encourage over-leverage. Mention risk sizing when giving a plan.
5. When reviewing the user's trades, find behavioural patterns (revenge trading, oversizing, cutting winners, breaking rules) from the stats and name them plainly but constructively.
6. Keep answers compact for a phone screen: short paragraphs or tight bullets, bold only for key levels and the verdict. No filler, no repeated disclaimers.
7. If the user asks something unrelated to trading or markets, answer briefly and steer back.`;

  async function post(url, headers, body, timeoutMs = 60000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* keep text */ }
      if (!res.ok) {
        const msg = (json && (json.error && (json.error.message || json.error))) || text.slice(0, 200);
        const err = new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        err.status = res.status; throw err;
      }
      return json;
    } catch (e) {
      if (e.name === 'AbortError') { const err = new Error('timed out'); err.status = 408; throw err; }
      throw e;
    } finally { clearTimeout(t); }
  }

  function toOpenAI(messages, image) {
    const out = messages.map((m) => ({ role: m.role, content: m.content }));
    if (image) {
      const lastUser = [...out].reverse().find((m) => m.role === 'user');
      lastUser.content = [{ type: 'text', text: lastUser.content }, { type: 'image_url', image_url: { url: image } }];
    }
    return out;
  }

  async function callOpenAICompat(p, cfg, messages, image, opts) {
    const base = p === 'ollama' ? (cfg.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '') + '/v1/chat/completions' : DEFAULTS[p].url;
    const headers = {};
    if (p !== 'ollama') headers.Authorization = 'Bearer ' + cfg[p + 'Key'];
    if (p === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Trade Assistant'; }
    const model = image ? (cfg[p + 'VisionModel'] || DEFAULTS[p].vision) : (cfg[p + 'Model'] || DEFAULTS[p].model);
    const j = await post(base, headers, {
      model, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens || 1400,
      messages: [{ role: 'system', content: opts.system || SYSTEM }, ...toOpenAI(messages, image)],
    }, p === 'ollama' ? 180000 : 60000);
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error('empty response');
    return { text, provider: p, model };
  }

  async function callGemini(cfg, messages, image, opts) {
    const model = image ? (cfg.geminiVisionModel || DEFAULTS.gemini.vision) : (cfg.geminiModel || DEFAULTS.gemini.model);
    const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (image) {
      const mt = /^data:(.*?);base64,(.*)$/.exec(image);
      const lastUser = [...contents].reverse().find((c) => c.role === 'user');
      lastUser.parts.push({ inline_data: { mime_type: mt[1], data: mt[2] } });
    }
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': cfg.geminiKey },
      { systemInstruction: { parts: [{ text: opts.system || SYSTEM }] }, contents, generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.maxTokens || 1600 } });
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    const text = parts && parts.map((p) => p.text || '').join('');
    if (!text) throw new Error('empty response' + (j.promptFeedback ? ' (blocked)' : ''));
    return { text, provider: 'gemini', model };
  }

  function available(cfg) {
    const list = [];
    for (const p of ['groq', 'gemini', 'openrouter']) if (cfg[p + 'Key']) list.push(p);
    if (cfg.ollamaEnabled) list.push('ollama');
    return list;
  }

  /* chat(): tries the preferred provider first, then falls back to the others on
     rate limits / outages, so one free tier running out doesn't stop you. */
  async function chat(cfg, messages, opts = {}) {
    const avail = available(cfg);
    if (!avail.length) throw new Error('No AI provider set up. Open Settings and add a free Groq or Gemini key (or enable Ollama).');
    const order = [cfg.provider, ...avail].filter((p, i, a) => avail.includes(p) && a.indexOf(p) === i);
    const errors = [];
    for (const p of order) {
      try {
        return p === 'gemini' ? await callGemini(cfg, messages, opts.image, opts) : await callOpenAICompat(p, cfg, messages, opts.image, opts);
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
        if (e.status && e.status < 500 && e.status !== 429 && e.status !== 408 && e.status !== 404 && e.status !== 400) { /* auth error etc: still try next */ }
      }
    }
    throw new Error('All providers failed.\n' + errors.join('\n'));
  }

  const api = { DEFAULTS, SYSTEM, chat, available };
  root.AI = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
