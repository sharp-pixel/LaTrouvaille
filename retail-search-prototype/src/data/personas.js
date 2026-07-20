export const MAX_PERSONA_QUERY_EXPANSION_LENGTH = 120;

function createSearchProfile(queryExpansion) {
  if (typeof queryExpansion !== "string" || queryExpansion.length > MAX_PERSONA_QUERY_EXPANSION_LENGTH) {
    throw new TypeError(`Persona query expansion must be at most ${MAX_PERSONA_QUERY_EXPANSION_LENGTH} characters`);
  }
  return Object.freeze({ queryExpansion });
}

export const personas = [
  {
    id: "anonymous",
    version: 1,
    name: "Anonymous",
    shortName: "Anonymous",
    archetype: "Open exploration",
    image: "/assets/personas/anonymous.jpg",
    demographics: "Age, gender, and location unspecified",
    background: "First visit with no account, history, or declared preferences.",
    mentalModel: "A storefront to scan broadly: learn the vocabulary, compare, and narrow as I go.",
    searchProfile: createSearchProfile(""),
  },
  {
    id: "first-luxury-purchase",
    version: 1,
    name: "Camille Moreau",
    shortName: "Camille",
    archetype: "First luxury purchase",
    image: "/assets/personas/camille-moreau.jpg",
    demographics: "Early 30s, Paris-based product designer",
    background: "A product designer buying a first pre-loved piece, with a firm EUR 1,500 budget.",
    mentalModel: "A guided boutique: start from the occasion, then validate condition, authenticity, and value.",
    searchProfile: createSearchProfile(
      "excellent condition very good condition verified timeless versatile value",
    ),
  },
  {
    id: "fashion-insider",
    version: 1,
    name: "Sofia Benali",
    shortName: "Sofia",
    archetype: "Fashion insider",
    image: "/assets/personas/sofia-benali.jpg",
    demographics: "Late 30s, French-Algerian freelance stylist",
    background: "A freelance stylist sourcing distinctive pieces for shoots and clients; fluent in houses and eras.",
    mentalModel: "A living archive: use precise brand, model, material, and season language; favor rarity and freshness.",
    searchProfile: createSearchProfile(
      "rare archive vintage runway editorial limited edition distinctive",
    ),
  },
  {
    id: "watch-collector",
    version: 1,
    name: "Julien Laurent",
    shortName: "Julien",
    archetype: "Watch collector",
    image: "/assets/personas/julien-laurent.jpg",
    demographics: "Late 40s, Lyon-based watch collector",
    background: "An experienced collector tracking dress watches across Europe and comfortable with resale pricing.",
    mentalModel: "A specialist inventory: exact model, condition, provenance, and price are decision fields.",
    searchProfile: createSearchProfile(
      "dress watch reference provenance full set serviced collector steel",
    ),
  },
];

export const defaultPersona = personas[0];

export function getPersonaById(personaId) {
  return personas.find((persona) => persona.id === personaId) || defaultPersona;
}

export function getPersonaSearchRequestIdentity(personaId) {
  return { personaId: getPersonaById(personaId).id };
}

// This is the only persona shape intended for search services or model context.
// It includes shopping context while deliberately excluding names, demographics, and images.
export function getPersonaSearchContext(personaId) {
  const persona = getPersonaById(personaId);
  return {
    personaId: persona.id,
    personaVersion: persona.version,
    archetype: persona.archetype,
    background: persona.background,
    mentalModel: persona.mentalModel,
    queryExpansion: persona.searchProfile.queryExpansion,
  };
}
