const APPLICATION = "maison-reuse-search-prototype";
const STORAGE_KEY = "maison-reuse-ubi-events";
const CLIENT_KEY = "maison-reuse-ubi-client-id";
const ENDPOINT = import.meta.env.VITE_UBI_ENDPOINT || "http://127.0.0.1:8787/ubi";

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ubi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getClientId() {
  const existing = localStorage.getItem(CLIENT_KEY);
  if (existing) return existing;
  const next = `web-${uuid()}`;
  localStorage.setItem(CLIENT_KEY, next);
  return next;
}

function appendLocal(record) {
  const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  const next = [record, ...existing].slice(0, 40);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

async function post(path, record) {
  try {
    await fetch(`${ENDPOINT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
      keepalive: true,
    });
  } catch {
    // Tier-2 telemetry must fail open for the customer journey.
  }
}

export function getRecentUbiEvents() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
}

function personaAttributes(persona) {
  if (!persona) return undefined;
  return {
    id: persona.id,
    version: persona.version,
    name: persona.name,
    archetype: persona.archetype,
  };
}

export function recordUbiQuery({ userQuery, rewrittenQuery, results, queryPlan, filters, sort, persona }) {
  const record = {
    application: APPLICATION,
    query_id: uuid(),
    client_id: getClientId(),
    persona_id: persona?.id,
    persona_version: persona?.version,
    timestamp: new Date().toISOString(),
    user_query: userQuery,
    query_response_object_ids: results.map((item) => item.item_id),
    query_attributes: {
      rewritten_query: rewrittenQuery,
      query_plan: queryPlan,
      filters,
      sort,
      result_count: results.length,
      persona: personaAttributes(persona),
    },
  };
  appendLocal({ type: "query", ...record });
  post("/query", record);
  return record;
}

export function recordUbiEvent({
  queryId,
  actionName,
  messageType = "INTERACTION",
  message,
  object,
  ordinal,
  persona,
  eventAttributes = {},
}) {
  const record = {
    application: APPLICATION,
    action_name: actionName,
    query_id: queryId,
    client_id: getClientId(),
    persona_id: persona?.id,
    persona_version: persona?.version,
    timestamp: new Date().toISOString(),
    message_type: messageType,
    message: message || actionName,
    event_attributes: {
      ...eventAttributes,
      persona: personaAttributes(persona),
      position: typeof ordinal === "number" ? { ordinal } : undefined,
      object: object
        ? {
            internal_id: object.id,
            object_id: object.item_id,
            object_id_field: "item_id",
            description: `${object.brand} ${object.title}`,
            object_detail: {
              brand: object.brand,
              category: object.category,
              price: object.price,
              condition: object.condition,
            },
          }
        : undefined,
    },
  };
  appendLocal({ type: "event", ...record });
  post("/event", record);
  return record;
}
