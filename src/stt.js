// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');

async function transcribeOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav, baseURL, model) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: baseURL || undefined });
  const res = await client.chat.completions.create({
    model: model || 'gemini-3-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Transcribe this audio verbatim. Return only clearly spoken words, with no commentary or completion. If the audio is silence, noise, music, an echo, or unclear, return an empty response. Never invent or guess words.' },
      { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }
    ] }],
    max_tokens: 900,
    temperature: 0
  });
  return (((res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '')).trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const chain = [];
  if (keys.openai) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel) });
  const baseURLs = settings.baseURLs || {};
  if (keys.gemini) chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav, baseURLs.gemini, settings.sttModel || 'gemini-3-flash') });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
