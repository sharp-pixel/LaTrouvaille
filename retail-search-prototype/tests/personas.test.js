import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PERSONA_QUERY_EXPANSION_LENGTH,
  getPersonaById,
  getPersonaSearchContext,
  getPersonaSearchRequestIdentity,
  personas,
} from "../src/data/personas.js";

test("persona search expansions are bounded and Anonymous remains unprofiled", () => {
  for (const persona of personas) {
    assert.equal(typeof persona.searchProfile.queryExpansion, "string");
    assert.ok(persona.searchProfile.queryExpansion.length <= MAX_PERSONA_QUERY_EXPANSION_LENGTH);
    assert.ok(Object.isFrozen(persona.searchProfile));
  }
  assert.equal(getPersonaById("anonymous").searchProfile.queryExpansion, "");
});

test("browser search identity contains only the allowlisted persona ID", () => {
  assert.deepEqual(getPersonaSearchRequestIdentity("fashion-insider"), { personaId: "fashion-insider" });
  assert.deepEqual(getPersonaSearchRequestIdentity("unknown"), { personaId: "anonymous" });
});

test("search context includes shopping details but excludes identifying presentation fields", () => {
  const persona = getPersonaById("fashion-insider");
  const context = getPersonaSearchContext(persona.id);

  assert.deepEqual(Object.keys(context).sort(), [
    "archetype",
    "background",
    "mentalModel",
    "personaId",
    "personaVersion",
    "queryExpansion",
  ]);
  assert.equal(context.personaId, persona.id);
  assert.equal(context.archetype, persona.archetype);
  assert.equal(context.background, persona.background);
  assert.equal(context.mentalModel, persona.mentalModel);
  assert.equal(context.queryExpansion, persona.searchProfile.queryExpansion);

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(persona.name), false);
  assert.equal(serialized.includes(persona.demographics), false);
  assert.equal(serialized.includes(persona.image), false);
});
