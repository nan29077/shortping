import { createHmac } from 'node:crypto';
import { call, dataUri, pcmToWav, VendorError } from './http.mjs';

// AI 공급사 연결부. 공급사마다 요청 형식이 달라서 "종류(kind)"별 어댑터로 감쌉니다.
// 모든 어댑터는 같은 약속을 지킵니다.
//   run({ provider, model, capability, input, key, secret }) → { status:'done', result } | { status:'pending', ref }
//   poll({ provider, model, capability, ref, key, secret })   → 위와 같음 (오래 걸리는 영상 생성 등)
//   test({ provider, key, secret })                           → 연결 확인(비용이 들지 않는 요청)
// 결과(result): text { text, usage:{input,output} } · image/video/tts { data:Buffer, mime } 또는 { url, headers }
//               stt { segments:[{start,end,text}] }
// base_url은 관리자가 바꿀 수 있어 지역 엔드포인트(중국 본토/해외)나 프록시로 옮길 수 있습니다.

const aspectSize = { '9:16': '1024x1536', '1:1': '1024x1024', '16:9': '1536x1024' };
const trimBase = (url, fallback) => String(url || fallback).replace(/\/+$/, '');
const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const ok = (result) => ({ status: 'done', result });
const pending = (ref) => ({ status: 'pending', ref });

// ── OpenAI 호환 채팅 (OpenAI · DeepSeek · Qwen · Kimi · GLM · Doubao 등) ──
async function chat(base, key, model, input, { maxField = 'max_tokens', extraHeaders = {} } = {}) {
  const data = await call(`${base}/chat/completions`, {
    headers: { ...bearer(key), ...extraHeaders },
    timeout: 180000,
    json: {
      model: model.model_id,
      messages: [
        ...(input.system ? [{ role: 'system', content: input.system }] : []),
        { role: 'user', content: input.prompt },
      ],
      [maxField]: input.maxTokens || 4000,
      ...(input.json ? { response_format: { type: 'json_object' } } : {}),
    },
  });
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new VendorError('AI가 빈 응답을 돌려줬어요.');
  return ok({ text, usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 } });
}
async function openaiImage(base, key, model, input) {
  const data = await call(`${base}/images/generations`, {
    headers: bearer(key),
    timeout: 180000,
    json: { model: model.model_id, prompt: input.prompt, size: aspectSize[input.aspect] || '1024x1536', n: 1 },
  });
  const item = data.data?.[0];
  if (item?.b64_json) return ok({ data: Buffer.from(item.b64_json, 'base64'), mime: 'image/png' });
  if (item?.url) return ok({ url: item.url });
  throw new VendorError('이미지 결과가 없어요.');
}

const openai = {
  label: 'OpenAI',
  capabilities: ['text', 'image', 'video', 'tts', 'stt'],
  base: 'https://api.openai.com/v1',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    if (capability === 'text') return chat(base, key, model, input, { maxField: 'max_completion_tokens' });
    if (capability === 'image') return openaiImage(base, key, model, input);
    if (capability === 'tts') {
      const data = await call(`${base}/audio/speech`, {
        headers: bearer(key),
        raw: true,
        json: {
          model: model.model_id,
          voice: input.voice || 'alloy',
          input: input.text,
          response_format: 'mp3',
          ...(input.instructions ? { instructions: input.instructions } : {}),
        },
      });
      return ok({ data, mime: 'audio/mpeg' });
    }
    if (capability === 'stt') {
      const form = new FormData();
      form.set('file', new Blob([input.audio.buffer], { type: input.audio.mime }), 'audio.' + (input.audio.ext || 'mp3'));
      form.set('model', model.model_id);
      form.set('response_format', 'verbose_json');
      form.set('language', 'ko');
      const data = await call(`${base}/audio/transcriptions`, { headers: bearer(key), body: form, timeout: 300000 });
      const segments = (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() }));
      if (!segments.length && data.text) segments.push({ start: 0, end: data.duration || 5, text: data.text });
      return ok({ segments });
    }
    if (capability === 'video') {
      const seconds = String([4, 8, 12].reduce((a, b) => (Math.abs(b - input.seconds) < Math.abs(a - input.seconds) ? b : a)));
      let body;
      let json;
      if (input.image) {
        body = new FormData();
        body.set('model', model.model_id);
        body.set('prompt', input.prompt);
        body.set('seconds', seconds);
        body.set('size', '720x1280');
        body.set('input_reference', new Blob([input.image.buffer], { type: input.image.mime }), 'frame.' + (input.image.ext || 'jpg'));
      } else json = { model: model.model_id, prompt: input.prompt, seconds, size: '720x1280' };
      const data = await call(`${base}/videos`, { headers: bearer(key), json, body });
      return pending(data.id);
    }
    throw new VendorError('지원하지 않는 작업이에요.', { retryable: false });
  },
  async poll({ provider, ref, key }) {
    const base = trimBase(provider.base_url, this.base);
    const data = await call(`${base}/videos/${ref}`, { method: 'GET', headers: bearer(key) });
    if (data.status === 'completed')
      return ok({ url: `${base}/videos/${ref}/content`, headers: bearer(key) });
    if (data.status === 'failed') throw new VendorError('영상 생성 실패: ' + (data.error?.message || '원인 미상'), { retryable: true });
    return pending(ref);
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/models`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    return '모델 목록 조회 성공';
  },
};

const openaiCompatible = {
  label: 'OpenAI 호환 (DeepSeek · Qwen · Kimi · GLM · Doubao 등)',
  capabilities: ['text', 'image'],
  base: '',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, '');
    if (!base) throw new VendorError('기본 주소(base URL)를 입력해 주세요.', { retryable: false });
    if (capability === 'text') return chat(base, key, model, input);
    if (capability === 'image') return openaiImage(base, key, model, input);
    throw new VendorError('지원하지 않는 작업이에요.', { retryable: false });
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, '')}/models`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    return '모델 목록 조회 성공';
  },
};

const anthropic = {
  label: 'Anthropic (Claude)',
  capabilities: ['text'],
  base: 'https://api.anthropic.com',
  headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  async run({ provider, model, input, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/v1/messages`, {
      headers: this.headers(key),
      timeout: 240000,
      json: {
        model: model.model_id,
        max_tokens: input.maxTokens || 4000,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content: input.prompt + (input.json ? '\n\nJSON 객체 하나만 출력하세요.' : '') }],
      },
    });
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (!text) throw new VendorError('AI가 빈 응답을 돌려줬어요.');
    return ok({ text, usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 } });
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/v1/models`, { method: 'GET', headers: this.headers(key), timeout: 20000 });
    return '모델 목록 조회 성공';
  },
};

const gemini = {
  label: 'Google Gemini · Veo',
  capabilities: ['text', 'image', 'video', 'tts'],
  base: 'https://generativelanguage.googleapis.com/v1beta',
  headers: (key) => ({ 'x-goog-api-key': key }),
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    const headers = this.headers(key);
    if (capability === 'video') {
      const instance = { prompt: input.prompt };
      if (input.image) instance.image = { bytesBase64Encoded: input.image.buffer.toString('base64'), mimeType: input.image.mime };
      const data = await call(`${base}/models/${model.model_id}:predictLongRunning`, {
        headers,
        json: { instances: [instance], parameters: { aspectRatio: input.aspect || '9:16', ...(input.seconds ? { durationSeconds: Math.min(8, Math.max(4, Math.round(input.seconds))) } : {}) } },
      });
      if (!data.name) throw new VendorError('영상 작업 번호를 받지 못했어요.');
      return pending(data.name);
    }
    const parts = [{ text: input.prompt || input.text }];
    if (capability === 'image' && input.refImage)
      parts.push({ inlineData: { mimeType: input.refImage.mime, data: input.refImage.buffer.toString('base64') } });
    const generationConfig =
      capability === 'image'
        ? { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: input.aspect || '9:16' } }
        : capability === 'tts'
          ? { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice || 'Kore' } } } }
          : { maxOutputTokens: input.maxTokens || 4000, ...(input.json ? { responseMimeType: 'application/json' } : {}) };
    const data = await call(`${base}/models/${model.model_id}:generateContent`, {
      headers,
      timeout: 240000,
      json: {
        ...(input.system && capability === 'text' ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
        contents: [{ role: 'user', parts }],
        generationConfig,
      },
    });
    const out = data.candidates?.[0]?.content?.parts || [];
    if (capability === 'text') {
      const text = out.map((p) => p.text || '').join('');
      if (!text) throw new VendorError('AI가 빈 응답을 돌려줬어요.');
      return ok({ text, usage: { input: data.usageMetadata?.promptTokenCount || 0, output: data.usageMetadata?.candidatesTokenCount || 0 } });
    }
    const inline = out.find((p) => p.inlineData)?.inlineData;
    if (!inline) throw new VendorError(capability === 'tts' ? '음성 결과가 없어요.' : '이미지 결과가 없어요.');
    const buffer = Buffer.from(inline.data, 'base64');
    if (capability === 'tts') {
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType || '')?.[1] || 24000);
      return ok({ data: /wav/.test(inline.mimeType) ? buffer : pcmToWav(buffer, rate), mime: 'audio/wav' });
    }
    return ok({ data: buffer, mime: inline.mimeType || 'image/png' });
  },
  async poll({ provider, ref, key }) {
    const base = trimBase(provider.base_url, this.base);
    const data = await call(`${base}/${ref}`, { method: 'GET', headers: this.headers(key) });
    if (!data.done) return pending(ref);
    if (data.error) throw new VendorError('영상 생성 실패: ' + (data.error.message || '원인 미상'));
    const sample = data.response?.generateVideoResponse?.generatedSamples?.[0] || data.response?.generatedVideos?.[0];
    const uri = sample?.video?.uri;
    if (!uri) throw new VendorError('영상 결과가 없어요(안전 정책으로 걸러졌을 수 있어요).', { retryable: false });
    return ok({ url: uri, headers: this.headers(key) });
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/models?pageSize=1`, { method: 'GET', headers: this.headers(key), timeout: 20000 });
    return '모델 목록 조회 성공';
  },
};

// fal · Replicate: Kling · Seedance · Hailuo · Wan · Flux · Seedream 등 여러 모델을 한 키로 씁니다.
function genericInput(capability, input) {
  if (capability === 'video')
    return {
      prompt: input.prompt,
      duration: String(Math.round(input.seconds || 5)),
      aspect_ratio: input.aspect || '9:16',
      ...(input.image ? { image_url: dataUri(input.image.buffer, input.image.mime) } : {}),
    };
  if (capability === 'image')
    return {
      prompt: input.prompt,
      aspect_ratio: input.aspect || '9:16',
      image_size: input.aspect === '16:9' ? 'landscape_16_9' : input.aspect === '1:1' ? 'square_hd' : 'portrait_16_9',
      ...(input.refImage ? { image_url: dataUri(input.refImage.buffer, input.refImage.mime) } : {}),
    };
  if (capability === 'tts') return { text: input.text, ...(input.voice ? { voice: input.voice } : {}) };
  if (capability === 'stt') return { audio_url: dataUri(input.audio.buffer, input.audio.mime), language: 'ko' };
  return { prompt: input.prompt };
}
function pickOutput(capability, out) {
  if (capability === 'stt') {
    const chunks = out.chunks || out.segments || [];
    const segments = chunks.map((c) => ({ start: c.timestamp?.[0] ?? c.start ?? 0, end: c.timestamp?.[1] ?? c.end ?? 0, text: String(c.text || '').trim() }));
    if (!segments.length && out.text) segments.push({ start: 0, end: 5, text: out.text });
    return { segments };
  }
  const candidates = [out.video, out.videos?.[0], out.images?.[0], out.image, out.audio, out.audio_file, out.output, Array.isArray(out) ? out[0] : out];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string' && /^(https?:|data:)/.test(c)) return { url: c };
    if (typeof c === 'object' && typeof c.url === 'string') return { url: c.url };
  }
  if (typeof out.audio_url === 'string') return { url: out.audio_url };
  throw new VendorError('결과 파일 주소를 찾지 못했어요.');
}
const fal = {
  label: 'fal.ai (여러 영상·이미지 모델 중계)',
  capabilities: ['image', 'video', 'tts', 'stt'],
  base: 'https://queue.fal.run',
  headers: (key) => ({ Authorization: `Key ${key}` }),
  async run({ provider, model, capability, input, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/${model.model_id}`, {
      headers: this.headers(key),
      json: genericInput(capability, input),
    });
    if (!data.request_id) throw new VendorError('작업 번호를 받지 못했어요.');
    return pending(JSON.stringify({ status: data.status_url, response: data.response_url }));
  },
  async poll({ capability, ref, key }) {
    const { status, response } = JSON.parse(ref);
    const s = await call(status, { method: 'GET', headers: this.headers(key) });
    if (s.status === 'COMPLETED') {
      const out = await call(response, { method: 'GET', headers: this.headers(key) });
      if (out.detail && !out.video && !out.images) throw new VendorError('생성 실패: ' + JSON.stringify(out.detail).slice(0, 200));
      return ok(pickOutput(capability, out));
    }
    if (s.status === 'FAILED' || s.error) throw new VendorError('생성 실패: ' + (s.error || '원인 미상'));
    return pending(ref);
  },
  async test({ provider, key }) {
    // 존재하지 않는 작업을 조회해 키만 확인합니다(401/403이면 키 오류).
    try {
      await call(`${trimBase(provider.base_url, this.base)}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`, { method: 'GET', headers: this.headers(key), timeout: 20000 });
    } catch (e) {
      if (e.status === 401) throw e;
    }
    return '키 확인 완료';
  },
};
const replicate = {
  label: 'Replicate (여러 모델 중계)',
  capabilities: ['text', 'image', 'video', 'tts', 'stt'],
  base: 'https://api.replicate.com/v1',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    const payload = genericInput(capability, input);
    if (payload.image_url) {
      payload.image = payload.image_url;
      payload.start_image = payload.image_url;
      delete payload.image_url;
    }
    const [name, version] = model.model_id.split(':');
    const data = version
      ? await call(`${base}/predictions`, { headers: bearer(key), json: { version, input: payload } })
      : await call(`${base}/models/${name}/predictions`, { headers: bearer(key), json: { input: payload } });
    return pending(data.id);
  },
  async poll({ provider, capability, ref, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/predictions/${ref}`, { method: 'GET', headers: bearer(key) });
    if (data.status === 'succeeded') {
      if (capability === 'text') {
        const text = Array.isArray(data.output) ? data.output.join('') : String(data.output || '');
        return ok({ text, usage: { input: 0, output: 0 } });
      }
      return ok(pickOutput(capability, typeof data.output === 'string' ? { output: data.output } : data.output || {}));
    }
    if (['failed', 'canceled'].includes(data.status)) throw new VendorError('생성 실패: ' + (data.error || data.status));
    return pending(ref);
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/account`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    return '계정 확인 완료';
  },
};

const elevenlabs = {
  label: 'ElevenLabs (음성)',
  capabilities: ['tts', 'stt'],
  base: 'https://api.elevenlabs.io/v1',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    if (capability === 'stt') {
      const form = new FormData();
      form.set('file', new Blob([input.audio.buffer], { type: input.audio.mime }), 'audio.' + (input.audio.ext || 'mp3'));
      form.set('model_id', model.model_id);
      form.set('language_code', 'kor');
      const data = await call(`${base}/speech-to-text`, { headers: { 'xi-api-key': key }, body: form, timeout: 300000 });
      // 단어 단위 결과를 2.5초 정도로 묶어 자막 줄을 만듭니다.
      const segments = [];
      let cur = null;
      for (const w of data.words || []) {
        if (w.type === 'spacing') continue;
        if (!cur || w.end - cur.start > 2.5) {
          if (cur) segments.push(cur);
          cur = { start: w.start, end: w.end, text: w.text };
        } else {
          cur.end = w.end;
          cur.text += ' ' + w.text;
        }
      }
      if (cur) segments.push(cur);
      if (!segments.length && data.text) segments.push({ start: 0, end: 5, text: data.text });
      return ok({ segments });
    }
    const voice = input.voice || 'JBFqnCBsd6RMkjVDRZzb';
    const data = await call(`${base}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      headers: { 'xi-api-key': key },
      raw: true,
      json: { text: input.text, model_id: model.model_id },
    });
    return ok({ data, mime: 'audio/mpeg' });
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/models`, { method: 'GET', headers: { 'xi-api-key': key }, timeout: 20000 });
    return '모델 목록 조회 성공';
  },
};

// ── 중국 공급사 직접 연결 ─────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function klingToken(access, secret) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: access, exp: now + 1800, nbf: now - 5 }));
  const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
const kling = {
  label: 'Kling AI (콰이쇼우 · 직접 연결)',
  capabilities: ['image', 'video'],
  base: 'https://api-singapore.klingai.com',
  secretLabel: 'Secret Key (API Key 칸에는 Access Key)',
  auth: (key, secret) => {
    if (!secret) throw new VendorError('Kling은 Access Key와 Secret Key가 모두 필요해요.', { status: 401, retryable: false });
    return bearer(klingToken(key, secret));
  },
  async run({ provider, model, capability, input, key, secret }) {
    const base = trimBase(provider.base_url, this.base);
    let path;
    let json;
    if (capability === 'video') {
      path = input.image ? '/v1/videos/image2video' : '/v1/videos/text2video';
      json = {
        model_name: model.model_id,
        prompt: input.prompt,
        duration: input.seconds > 7 ? '10' : '5',
        ...(input.image ? { image: input.image.buffer.toString('base64') } : { aspect_ratio: input.aspect || '9:16' }),
      };
    } else if (capability === 'image') {
      path = '/v1/images/generations';
      json = { model_name: model.model_id, prompt: input.prompt, aspect_ratio: input.aspect || '9:16', n: 1 };
    } else throw new VendorError('지원하지 않는 작업이에요.', { retryable: false });
    const data = await call(base + path, { headers: this.auth(key, secret), json });
    if (data.code !== 0 || !data.data?.task_id) throw new VendorError('Kling 오류: ' + (data.message || data.code));
    return pending(JSON.stringify({ path, id: data.data.task_id }));
  },
  async poll({ provider, capability, ref, key, secret }) {
    const { path, id } = JSON.parse(ref);
    const data = await call(`${trimBase(provider.base_url, this.base)}${path}/${id}`, { method: 'GET', headers: this.auth(key, secret) });
    const task = data.data || {};
    if (task.task_status === 'succeed') {
      const url = capability === 'video' ? task.task_result?.videos?.[0]?.url : task.task_result?.images?.[0]?.url;
      if (!url) throw new VendorError('결과 주소가 없어요.');
      return ok({ url });
    }
    if (task.task_status === 'failed') throw new VendorError('Kling 생성 실패: ' + (task.task_status_msg || '원인 미상'));
    return pending(ref);
  },
  async test({ provider, key, secret }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/v1/videos/text2video?pageNum=1&pageSize=1`, { method: 'GET', headers: this.auth(key, secret), timeout: 20000 });
    if (data.code !== 0) throw new VendorError('Kling 오류: ' + (data.message || data.code), { status: 401 });
    return '작업 목록 조회 성공';
  },
};
const minimax = {
  label: 'MiniMax (Hailuo 영상 · 음성)',
  capabilities: ['video', 'tts'],
  base: 'https://api.minimax.io/v1',
  check(data) {
    const code = data.base_resp?.status_code;
    if (code && code !== 0)
      throw new VendorError('MiniMax 오류: ' + (data.base_resp.status_msg || code), { status: code === 1004 ? 401 : 502, retryable: code === 1002 || code === 1039 });
    return data;
  },
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    if (capability === 'tts') {
      const data = this.check(
        await call(`${base}/t2a_v2`, {
          headers: bearer(key),
          json: {
            model: model.model_id,
            text: input.text,
            stream: false,
            language_boost: 'Korean',
            voice_setting: { voice_id: input.voice || 'Korean_SweetGirl', speed: 1, vol: 1, pitch: 0 },
            audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
          },
        }),
      );
      if (!data.data?.audio) throw new VendorError('음성 결과가 없어요.');
      return ok({ data: Buffer.from(data.data.audio, 'hex'), mime: 'audio/mpeg' });
    }
    if (capability === 'video') {
      const data = this.check(
        await call(`${base}/video_generation`, {
          headers: bearer(key),
          json: {
            model: model.model_id,
            prompt: input.prompt,
            duration: input.seconds > 7 ? 10 : 6,
            ...(input.image ? { first_frame_image: dataUri(input.image.buffer, input.image.mime) } : {}),
          },
        }),
      );
      return pending(data.task_id);
    }
    throw new VendorError('지원하지 않는 작업이에요.', { retryable: false });
  },
  async poll({ provider, ref, key }) {
    const base = trimBase(provider.base_url, this.base);
    const data = this.check(await call(`${base}/query/video_generation?task_id=${encodeURIComponent(ref)}`, { method: 'GET', headers: bearer(key) }));
    if (data.status === 'Success') {
      const file = this.check(await call(`${base}/files/retrieve?file_id=${encodeURIComponent(data.file_id)}`, { method: 'GET', headers: bearer(key) }));
      if (!file.file?.download_url) throw new VendorError('결과 주소가 없어요.');
      return ok({ url: file.file.download_url });
    }
    if (data.status === 'Fail') throw new VendorError('Hailuo 생성 실패');
    return pending(ref);
  },
  async test({ provider, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/query/video_generation?task_id=0`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    if (data.base_resp?.status_code === 1004) throw new VendorError('MiniMax 키가 올바르지 않아요.', { status: 401 });
    return '키 확인 완료';
  },
};
const dashscope = {
  label: 'Alibaba DashScope (Wan 영상 · 이미지)',
  capabilities: ['image', 'video'],
  base: 'https://dashscope-intl.aliyuncs.com/api/v1',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    const headers = { ...bearer(key), 'X-DashScope-Async': 'enable' };
    const json =
      capability === 'video'
        ? {
            model: model.model_id,
            input: { prompt: input.prompt, ...(input.image ? { img_url: dataUri(input.image.buffer, input.image.mime) } : {}) },
            parameters: { ...(input.image ? { resolution: '720P' } : { size: '720*1280' }), duration: Math.round(input.seconds || 5) },
          }
        : { model: model.model_id, input: { prompt: input.prompt }, parameters: { size: '720*1280', n: 1 } };
    const path = capability === 'video' ? '/services/aigc/video-generation/video-synthesis' : '/services/aigc/text2image/image-synthesis';
    const data = await call(base + path, { headers, json });
    if (!data.output?.task_id) throw new VendorError('작업 번호를 받지 못했어요: ' + (data.message || ''));
    return pending(data.output.task_id);
  },
  async poll({ provider, capability, ref, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/tasks/${ref}`, { method: 'GET', headers: bearer(key) });
    const o = data.output || {};
    if (o.task_status === 'SUCCEEDED') {
      const url = capability === 'video' ? o.video_url : o.results?.[0]?.url;
      if (!url) throw new VendorError('결과 주소가 없어요.');
      return ok({ url });
    }
    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(o.task_status)) throw new VendorError('생성 실패: ' + (o.message || o.task_status));
    return pending(ref);
  },
  async test({ provider, key }) {
    try {
      await call(`${trimBase(provider.base_url, this.base)}/tasks/00000000-0000-0000-0000-000000000000`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    } catch (e) {
      if (e.status === 401) throw e;
    }
    return '키 확인 완료';
  },
};
const volcengine = {
  label: 'ByteDance 화산엔진 Ark (Seedance 영상 · Seedream 이미지 · Doubao)',
  capabilities: ['text', 'image', 'video'],
  base: 'https://ark.cn-beijing.volces.com/api/v3',
  async run({ provider, model, capability, input, key }) {
    const base = trimBase(provider.base_url, this.base);
    if (capability === 'text') return chat(base, key, model, input);
    if (capability === 'image') {
      const data = await call(`${base}/images/generations`, {
        headers: bearer(key),
        timeout: 180000,
        json: { model: model.model_id, prompt: input.prompt, size: input.aspect === '1:1' ? '1024x1024' : '720x1280', response_format: 'b64_json', watermark: false },
      });
      const item = data.data?.[0];
      if (item?.b64_json) return ok({ data: Buffer.from(item.b64_json, 'base64'), mime: 'image/jpeg' });
      if (item?.url) return ok({ url: item.url });
      throw new VendorError('이미지 결과가 없어요.');
    }
    const content = [{ type: 'text', text: `${input.prompt} --ratio ${input.aspect || '9:16'} --dur ${Math.round(input.seconds || 5)}` }];
    if (input.image) content.push({ type: 'image_url', image_url: { url: dataUri(input.image.buffer, input.image.mime) } });
    const data = await call(`${base}/contents/generations/tasks`, { headers: bearer(key), json: { model: model.model_id, content } });
    if (!data.id) throw new VendorError('작업 번호를 받지 못했어요.');
    return pending(data.id);
  },
  async poll({ provider, ref, key }) {
    const data = await call(`${trimBase(provider.base_url, this.base)}/contents/generations/tasks/${ref}`, { method: 'GET', headers: bearer(key) });
    if (data.status === 'succeeded') {
      if (!data.content?.video_url) throw new VendorError('결과 주소가 없어요.');
      return ok({ url: data.content.video_url });
    }
    if (['failed', 'cancelled', 'expired'].includes(data.status)) throw new VendorError('생성 실패: ' + (data.error?.message || data.status));
    return pending(ref);
  },
  async test({ provider, key }) {
    await call(`${trimBase(provider.base_url, this.base)}/contents/generations/tasks?page_num=1&page_size=1`, { method: 'GET', headers: bearer(key), timeout: 20000 });
    return '작업 목록 조회 성공';
  },
};

// 모델 목록 불러오기(관리자 편의): 목록 API가 있는 공급사만 지원합니다.
const listOpenai = async (base, key) =>
  ((await call(`${base}/models`, { method: 'GET', headers: bearer(key), timeout: 20000 })).data || []).map((m) => m.id).filter(Boolean);
openai.listModels = ({ provider, key }) => listOpenai(trimBase(provider.base_url, openai.base), key);
openaiCompatible.listModels = ({ provider, key }) => listOpenai(trimBase(provider.base_url, ''), key);
volcengine.listModels = ({ provider, key }) => listOpenai(trimBase(provider.base_url, volcengine.base), key);
anthropic.listModels = async ({ provider, key }) =>
  ((await call(`${trimBase(provider.base_url, anthropic.base)}/v1/models?limit=100`, { method: 'GET', headers: anthropic.headers(key), timeout: 20000 })).data || []).map((m) => m.id);
gemini.listModels = async ({ provider, key }) =>
  ((await call(`${trimBase(provider.base_url, gemini.base)}/models?pageSize=200`, { method: 'GET', headers: gemini.headers(key), timeout: 20000 })).models || []).map((m) =>
    String(m.name || '').replace(/^models\//, ''),
  );
elevenlabs.listModels = async ({ provider, key }) =>
  ((await call(`${trimBase(provider.base_url, elevenlabs.base)}/models`, { method: 'GET', headers: { 'xi-api-key': key }, timeout: 20000 })) || []).map((m) => m.model_id);

export const adapters = {
  openai,
  openai_compatible: openaiCompatible,
  anthropic,
  gemini,
  fal,
  replicate,
  elevenlabs,
  kling,
  minimax,
  dashscope,
  volcengine,
};
export const capabilityLabel = { text: '기획·대본', image: '이미지', video: '영상', tts: '음성(TTS)', stt: '자막(음성 인식)' };
export const unitOf = { text: 'per_1k_tokens', image: 'per_image', video: 'per_second', tts: 'per_1k_chars', stt: 'per_minute' };

// 관리자가 한 번에 추가할 수 있는 공급사·모델 프리셋. 가격(USD)은 2026년 7월 공개 가격을 참고한 기본값이며,
// 모델 ID와 가격은 공급사 문서를 확인해 관리자 화면에서 바로 고칠 수 있습니다.
const m = (capability, model_id, label, tier, cost_usd, tags = '', extra = {}) => ({ capability, model_id, label, tier, cost_usd, tags, ...extra });
export const presets = [
  {
    kind: 'openai', name: 'OpenAI', country: 'US', base_url: openai.base,
    models: [
      m('text', 'gpt-5', 'GPT-5', 'premium', 0.006, 'korean,story'),
      m('text', 'gpt-5-mini', 'GPT-5 mini', 'draft', 0.0012, 'korean,fast'),
      m('image', 'gpt-image-1', 'GPT Image', 'standard', 0.04, 'character,poster'),
      m('tts', 'gpt-4o-mini-tts', 'OpenAI TTS', 'standard', 0.015, 'korean'),
      m('stt', 'whisper-1', 'Whisper', 'standard', 0.006, 'korean'),
      m('video', 'sora-2', 'OpenAI 영상 (Sora 2 · 공급 여부 확인)', 'standard', 0.1, 'cinematic', { max_seconds: 12, image_input: 1, active: 0 }),
    ],
  },
  {
    kind: 'anthropic', name: 'Anthropic Claude', country: 'US', base_url: anthropic.base,
    models: [
      m('text', 'claude-opus-4-5', 'Claude Opus', 'premium', 0.04, 'korean,story'),
      m('text', 'claude-sonnet-4-5', 'Claude Sonnet', 'standard', 0.009, 'korean,story'),
    ],
  },
  {
    kind: 'gemini', name: 'Google Gemini · Veo', country: 'US', base_url: gemini.base,
    models: [
      m('text', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'standard', 0.006, 'korean,story'),
      m('text', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'draft', 0.0012, 'korean,fast'),
      m('image', 'gemini-2.5-flash-image', 'Gemini 이미지', 'standard', 0.039, 'character,poster,consistency'),
      m('video', 'veo-3.1-generate-preview', 'Veo 3.1', 'premium', 0.75, 'dialogue,closeup,cinematic,lipsync', { max_seconds: 8, image_input: 1 }),
      m('video', 'veo-3.1-fast-generate-preview', 'Veo 3.1 Fast', 'standard', 0.15, 'dialogue,cinematic', { max_seconds: 8, image_input: 1 }),
      m('tts', 'gemini-2.5-flash-preview-tts', 'Gemini TTS', 'draft', 0.01, 'korean'),
    ],
  },
  {
    kind: 'fal', name: 'fal.ai', country: 'US', base_url: fal.base,
    models: [
      m('video', 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video', 'Kling 2.5 Turbo (fal)', 'standard', 0.07, 'action,character,consistency', { max_seconds: 10, image_input: 1 }),
      m('video', 'fal-ai/bytedance/seedance/v1/pro/image-to-video', 'Seedance Pro (fal)', 'standard', 0.1, 'cinematic,action', { max_seconds: 10, image_input: 1 }),
      m('video', 'fal-ai/minimax/hailuo-02/standard/image-to-video', 'Hailuo 02 (fal)', 'draft', 0.045, 'cheap,scene', { max_seconds: 10, image_input: 1 }),
      m('video', 'fal-ai/wan/v2.2-a14b/image-to-video', 'Wan 2.2 (fal)', 'draft', 0.05, 'cheap,landscape', { max_seconds: 5, image_input: 1 }),
      m('image', 'fal-ai/flux/dev', 'FLUX dev (fal)', 'draft', 0.025, 'cheap,landscape'),
      m('image', 'fal-ai/bytedance/seedream/v4/text-to-image', 'Seedream 4 (fal)', 'standard', 0.03, 'character,poster'),
    ],
  },
  {
    kind: 'replicate', name: 'Replicate', country: 'US', base_url: replicate.base,
    models: [
      m('video', 'kwaivgi/kling-v2.1', 'Kling 2.1 (Replicate)', 'standard', 0.1, 'action,character', { max_seconds: 10, image_input: 1 }),
      m('image', 'black-forest-labs/flux-schnell', 'FLUX schnell (Replicate)', 'draft', 0.003, 'cheap'),
    ],
  },
  {
    kind: 'elevenlabs', name: 'ElevenLabs', country: 'US', base_url: elevenlabs.base,
    models: [
      m('tts', 'eleven_multilingual_v2', 'ElevenLabs 다국어 v2', 'premium', 0.1, 'korean,emotion'),
      m('tts', 'eleven_flash_v2_5', 'ElevenLabs Flash', 'standard', 0.05, 'korean,fast'),
      m('stt', 'scribe_v1', 'ElevenLabs Scribe', 'standard', 0.0067, 'korean'),
    ],
  },
  {
    kind: 'kling', name: 'Kling AI (직접)', country: 'CN', base_url: kling.base,
    models: [m('video', 'kling-v2-1', 'Kling 2.1 (직접)', 'standard', 0.1, 'action,character,consistency', { max_seconds: 10, image_input: 1 })],
  },
  {
    kind: 'minimax', name: 'MiniMax Hailuo', country: 'CN', base_url: minimax.base,
    models: [
      m('video', 'MiniMax-Hailuo-02', 'Hailuo 02 (직접)', 'draft', 0.045, 'cheap,scene', { max_seconds: 10, image_input: 1 }),
      m('tts', 'speech-02-hd', 'MiniMax 음성 HD', 'standard', 0.05, 'korean,emotion'),
    ],
  },
  {
    kind: 'dashscope', name: 'Alibaba Wan', country: 'CN', base_url: dashscope.base,
    models: [
      m('video', 'wan2.2-i2v-plus', 'Wan 2.2 (직접)', 'draft', 0.05, 'cheap,landscape', { max_seconds: 5, image_input: 1 }),
      m('image', 'wan2.2-t2i-plus', 'Wan 이미지', 'draft', 0.02, 'cheap'),
    ],
  },
  {
    kind: 'volcengine', name: 'ByteDance Ark', country: 'CN', base_url: volcengine.base,
    models: [
      m('video', 'doubao-seedance-1-0-pro-250528', 'Seedance 1.0 Pro (직접)', 'standard', 0.092, 'cinematic,action', { max_seconds: 10, image_input: 1 }),
      m('image', 'doubao-seedream-4-0-250828', 'Seedream 4 (직접)', 'standard', 0.03, 'character,poster'),
    ],
  },
  { kind: 'openai_compatible', name: 'DeepSeek', country: 'CN', base_url: 'https://api.deepseek.com/v1', models: [m('text', 'deepseek-chat', 'DeepSeek V3', 'draft', 0.0008, 'cheap,fast')] },
  { kind: 'openai_compatible', name: 'Qwen (Alibaba)', country: 'CN', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: [m('text', 'qwen-plus', 'Qwen Plus', 'draft', 0.001, 'cheap')] },
  { kind: 'openai_compatible', name: 'Moonshot Kimi', country: 'CN', base_url: 'https://api.moonshot.ai/v1', models: [m('text', 'kimi-k2-0905-preview', 'Kimi K2', 'standard', 0.002, 'story')] },
  { kind: 'openai_compatible', name: 'Zhipu GLM', country: 'CN', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: [m('text', 'glm-4.5', 'GLM-4.5', 'standard', 0.002, 'story')] },
];
export const kindCatalog = Object.fromEntries(
  Object.entries(adapters).map(([kind, a]) => [kind, { label: a.label, capabilities: a.capabilities, base: a.base, secretLabel: a.secretLabel || '' }]),
);
