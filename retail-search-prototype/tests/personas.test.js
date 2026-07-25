import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PERSONA_QUERY_EXPANSION_LENGTH,
  getEffectiveSearchPersona,
  getPersonaById,
  getPersonaQueryExpansion,
  getPersonaSearchContext,
  getPersonaSearchRequestIdentity,
  personas,
} from "../src/data/personas.js";

test("persona search expansions are bounded and Anonymous remains unprofiled", () => {
  for (const persona of personas) {
    assert.equal(typeof persona.searchProfile.queryExpansion, "string");
    assert.ok(persona.searchProfile.queryExpansion.length <= MAX_PERSONA_QUERY_EXPANSION_LENGTH);
    assert.ok(Object.isFrozen(persona.searchProfile));
    assert.ok(Object.isFrozen(persona.searchProfile.categoryQueryExpansions));
    for (const expansion of Object.values(persona.searchProfile.categoryQueryExpansions)) {
      assert.ok(expansion.length <= MAX_PERSONA_QUERY_EXPANSION_LENGTH);
    }
  }
  assert.equal(getPersonaById("anonymous").searchProfile.queryExpansion, "");
});

test("watch intent selects each named persona's watch preference", () => {
  const camille = getPersonaById("first-luxury-purchase");
  const sofia = getPersonaById("fashion-insider");
  const julien = getPersonaById("watch-collector");

  assert.match(getPersonaQueryExpansion(camille, ["Watches"]), /bracelet jewellery sculptural/);
  assert.match(getPersonaQueryExpansion(sofia, ["watches"]), /bracelet jewellery sculptural/);
  assert.match(getPersonaQueryExpansion(julien, ["Watches"]), /traditional dress automatic/);
  assert.equal(getPersonaQueryExpansion(camille, ["Bags"]), camille.searchProfile.queryExpansion);
});

test("browser search identity contains only the allowlisted persona ID", () => {
  assert.deepEqual(getPersonaSearchRequestIdentity("fashion-insider"), { personaId: "fashion-insider" });
  assert.deepEqual(getPersonaSearchRequestIdentity("unknown"), { personaId: "anonymous" });
});

test("query-understanding bypass forces Anonymous regardless of the selected persona", () => {
  assert.equal(getEffectiveSearchPersona("watch-collector", true).id, "watch-collector");
  assert.equal(getEffectiveSearchPersona("watch-collector", false).id, "anonymous");
  assert.equal(getEffectiveSearchPersona("unknown", true).id, "anonymous");
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
  assert.equal(
    getPersonaSearchContext(persona.id, ["Watches"]).queryExpansion,
    persona.searchProfile.categoryQueryExpansions.Watches,
  );

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(persona.name), false);
  assert.equal(serialized.includes(persona.demographics), false);
  assert.equal(serialized.includes(persona.image), false);
});
