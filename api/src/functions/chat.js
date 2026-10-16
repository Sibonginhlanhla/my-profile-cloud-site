const { app } = require('@azure/functions');

const hits = new Map(); // simple per-instance rate limit
let cached = { token: null, exp: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.AZ_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AZ_CLIENT_ID,
      client_secret: process.env.AZ_CLIENT_SECRET,
      scope: 'https://ai.azure.com/.default',
    }),
  });
  if (!res.ok) throw new Error('Token request failed: ' + res.status);
  const d = await res.json();
  cached = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return cached.token;
}

function extractText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  return (data.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('\n');
}

app.http('chat', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (req) => {
    // Limits: 5 messages/minute and 20/hour per visitor (web search costs money)
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0];
    const now = Date.now();
    const all = (hits.get(ip) || []).filter((t) => now - t < 3600000);
    if (all.filter((t) => now - t < 60000).length >= 5 || all.length >= 20) {
      return { status: 429, jsonBody: { reply: 'You have hit the message limit. Please try again in a few minutes.' } };
    }
    hits.set(ip, [...all, now]);

    let body;
    try { body = await req.json(); } catch { return { status: 400, jsonBody: { reply: 'Invalid request.' } }; }
    const input = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
    if (!input.length) return { status: 400, jsonBody: { reply: 'Ask a question first.' } };

    try {
      const token = await getToken();
      const base = process.env.PROJECT_ENDPOINT.replace(/\/$/, '');
      const res = await fetch(`${base}/openai/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent: { type: 'agent_reference', name: process.env.AGENT_NAME }, input }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('Agent error', res.status, errText);
        return { status: 502, jsonBody: { reply: 'DEBUG ' + res.status + ': ' + errText.slice(0, 300) } };
      }
      const reply = extractText(await res.json());
      return { jsonBody: { reply: reply || 'No answer came back. Try rephrasing your question.' } };
    } catch (e) {
      console.error(e);
      return { status: 500, jsonBody: { reply: 'DEBUG: ' + e.message } };
    }
  },
});
