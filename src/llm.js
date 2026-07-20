// LLM factory — OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, baseURL }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: baseURL || undefined });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamGemini(args) {
  // Gemini providers behind OpenAI-compatible gateways use the same request
  // format as OpenAI; this also keeps custom base URLs working.
  return streamOpenAI(args);
}

function createLLM(settings, options = {}) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = keys[provider];
  const tier = options.fast ? 'fast' : (settings.smart ? 'smart' : 'fast');
  const model = (settings.models[provider] || {})[tier];
  const baseURL = (settings.baseURLs && settings.baseURLs[provider]) || undefined;
  const maxTokens = options.maxTokens || (tier === 'smart' ? 1400 : 700);
  const languageRule = 'Отвечай только на русском языке. Английский используй только внутри кода, команд, названий технологий, API и других неизменяемых технических идентификаторов.';

  return {
    provider, model, apiKey,
    ready: !!apiKey && !!model,
    async stream(params) {
      const system = [params.system, languageRule].filter(Boolean).join('\n\n');
      const args = { apiKey, model, maxTokens, baseURL, ...params, system };
      if (provider === 'openai') return streamOpenAI(args);
      if (provider === 'anthropic') return streamAnthropic(args);
      if (provider === 'gemini') return streamGemini(args);
      throw new Error('unknown provider: ' + provider);
    }
  };
}

module.exports = { createLLM };
