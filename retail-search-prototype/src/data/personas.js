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
  },
];

export const defaultPersona = personas[0];

export function getPersonaById(personaId) {
  return personas.find((persona) => persona.id === personaId) || defaultPersona;
}
