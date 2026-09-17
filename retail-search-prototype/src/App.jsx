import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Heart,
  Menu,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { categoryTiles, filterGroups, navItems, popularSearches, products } from "./data/catalog.js";
import {
  defaultPersona,
  getEffectiveSearchPersona,
  getPersonaById,
  getPersonaSearchRequestIdentity,
  personas,
} from "./data/personas.js";
import { buildLocalPersonalizationPlan } from "./lib/agentic-search.js";
import { createLiteralQueryPlan, createQueryUnderstanding } from "./lib/search.js";
import { useDialogFocus } from "./lib/use-dialog-focus.js";
import { getRecentUbiEvents, recordUbiEvent, recordUbiQuery } from "./lib/ubi.js";

const SEARCH_ENDPOINT = import.meta.env.VITE_SEARCH_ENDPOINT || "http://127.0.0.1:8790";
const BRAND_NAME = "La Trouvaille";
const DEFAULT_MAX_PRICE = 20000;
const PERSONA_STORAGE_KEY = "la-trouvaille-demo-persona";
const SORT_OPTIONS = ["Recommended", "Newest", "Lowest price", "Price drop"];
const discoveryEdits = [
  {
    title: "Carried well",
    query: "soft leather bag",
    image: "/assets/products/studio-v1/celenne-knot-black-leather-tote.png",
    meta: "Enduring leather shapes with character",
  },
  {
    title: "After-dark silk",
    query: "silk dress",
    image: "/assets/products/studio-v1/zelie-varenne-burgundy-silk-maxi-dress.png",
    meta: "Fluid pieces for the long light",
  },
  {
    title: "Soft structure",
    query: "tailored wool",
    image: "/assets/products/studio-v1/belladonna-tailored-wool-blazer.png",
    meta: "Quiet tailoring with a lived-in ease",
  },
];

const formatPrice = (price) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price);

const formatResultCount = (count, relation) => {
  const formatted = Number(count || 0).toLocaleString("en-US");
  return relation === "gte" ? `${formatted}+` : formatted;
};

const formatDslQuery = (dslQuery) => {
  if (!dslQuery) return "No OpenSearch DSL was executed.";
  try {
    const parsed = typeof dslQuery === "string" ? JSON.parse(dslQuery) : dslQuery;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(dslQuery);
  }
};

const getInitialPersona = () => {
  try {
    return getPersonaById(localStorage.getItem(PERSONA_STORAGE_KEY));
  } catch {
    return defaultPersona;
  }
};

export function App() {
  const personaReturnFocusRef = useRef(null);
  const mobileMenuButtonRef = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [mode, setMode] = useState("home");
  const [sort, setSort] = useState("Recommended");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [filters, setFilters] = useState({ category: [], condition: [], material: [], country: [] });
  const [maxPrice, setMaxPrice] = useState(DEFAULT_MAX_PRICE);
  const [favorites, setFavorites] = useState(new Set(["MR-0000001", "MR-0000009"]));
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [queryUnderstandingEnabled, setQueryUnderstandingEnabled] = useState(true);
  // Model picker: which agentic-lt-<model>-v1 pipeline Agentic Search routes through.
  const [agenticModels, setAgenticModels] = useState([]);
  const [selectedPipeline, setSelectedPipeline] = useState("");
  const [personaSelectorOpen, setPersonaSelectorOpen] = useState(false);
  const [activePersona, setActivePersona] = useState(getInitialPersona);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [ubiQueryId, setUbiQueryId] = useState("");
  const [ubiEvents, setUbiEvents] = useState(getRecentUbiEvents);
  const [searchResponse, setSearchResponse] = useState({
    products: null,
    personaId: null,
    queryPlan: null,
    source: "pending",
    status: "idle",
    error: null,
    tookMs: null,
    total: products.length,
    totalRelation: "eq",
    enhancements: { querqy: "not_called", rules: [] },
  });

  // Discover available agentic model pipelines (data-driven: a new fine-tuned
  // pipeline appears here automatically). Default the picker to the server default.
  useEffect(() => {
    let cancelled = false;
    fetch(`${SEARCH_ENDPOINT}/agentic-pipelines`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.models)) return;
        setAgenticModels(data.models);
        setSelectedPipeline((current) =>
          current || data.default || (data.models[0] && data.models[0].id) || "",
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const localPlan = useMemo(
    () => queryUnderstandingEnabled && activePersona.id !== "anonymous"
      ? createQueryUnderstanding(activeQuery, products)
      : createLiteralQueryPlan(activeQuery),
    [activeQuery, queryUnderstandingEnabled, activePersona.id],
  );
  const searchPersona = getEffectiveSearchPersona(activePersona.id, queryUnderstandingEnabled);
  const localPersonalizationPlan = useMemo(
    () => ({
      ...buildLocalPersonalizationPlan(localPlan, searchPersona, filters.category),
      queryUnderstanding: { status: queryUnderstandingEnabled ? "enabled" : "bypassed" },
    }),
    [filters.category, localPlan, queryUnderstandingEnabled, searchPersona],
  );
  const requestKey = JSON.stringify({
    activeQuery, filters, maxPrice, sort, personaId: activePersona.id,
    queryUnderstanding: queryUnderstandingEnabled, pipeline: selectedPipeline, searchAttempt,
  });
  const activePlan = useMemo(() => {
    const returnedPlan = searchResponse.requestKey === requestKey ? searchResponse.queryPlan : null;
    if (!returnedPlan) return localPersonalizationPlan;
    return {
      ...localPlan,
      ...returnedPlan,
      rewritten: returnedPlan.personalizedRewrite || returnedPlan.rewritten || localPlan.rewritten,
    };
  }, [localPersonalizationPlan, localPlan, requestKey, searchResponse.requestKey, searchResponse.queryPlan]);
  const suggestions = useMemo(() => {
    const seed = query.trim().toLowerCase();
    if (!seed) return popularSearches.slice(0, 6);
    return popularSearches.filter((item) => item.includes(seed)).slice(0, 6);
  }, [query]);

  const sortedProducts = searchResponse.requestKey === requestKey ? searchResponse.products ?? [] : [];

  useEffect(() => {
    if (mode !== "results") return undefined;
    const controller = new AbortController();
    const startedAt = performance.now();
    setUbiQueryId("");
    setSearchResponse({
      requestKey,
      products: [],
      personaId: searchPersona.id,
      queryPlan: localPersonalizationPlan,
      source: "pending",
      status: "loading",
      error: null,
      tookMs: null,
      total: 0,
      totalRelation: "eq",
      enhancements: { querqy: "not_called", rules: [] },
    });

    fetch(`${SEARCH_ENDPOINT}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: activeQuery,
        filters,
        maxPrice,
        sort,
        size: 96,
        queryUnderstanding: queryUnderstandingEnabled,
        ...(selectedPipeline ? { pipeline: selectedPipeline } : {}),
        ...getPersonaSearchRequestIdentity(activePersona.id),
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`Search API returned ${response.status} without a JSON response`);
        }
        if (!response.ok) {
          throw new Error(payload.error || `Search API returned ${response.status}`);
        }
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (payload.source !== "opensearch") {
          throw new Error(`Search API returned unsupported source: ${payload.source || "unknown"}`);
        }
        const tookMs = payload.tookMs ?? Math.round(performance.now() - startedAt);
        // Capture the request and response together. A separate effect can pair
        // new controls with the previous ready response before loading renders.
        const queryRecord = recordUbiQuery({
          userQuery: activeQuery,
          rewrittenQuery: payload.queryPlan?.personalizedRewrite || payload.queryPlan?.rewritten || localPlan.rewritten,
          queryPlan: { ...(payload.queryPlan || localPlan), source: "opensearch", took_ms: tookMs },
          results: (payload.products || []).slice(0, 24),
          filters,
          sort,
          persona: activePersona,
        });
        setUbiQueryId(queryRecord.query_id);
        setUbiEvents(getRecentUbiEvents());
        setSearchResponse({
          requestKey,
          products: payload.products || [],
          personaId: searchPersona.id,
          queryPlan: payload.queryPlan || null,
          source: "opensearch",
          status: "ready",
          error: null,
          tookMs,
          total: payload.total ?? payload.products?.length ?? 0,
          totalRelation: payload.totalRelation || "eq",
          enhancements: payload.enhancements || { querqy: "not_called", rules: [] },
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSearchResponse({
          requestKey,
          products: [],
          personaId: searchPersona.id,
          queryPlan: null,
          source: "unavailable",
          status: "error",
          error: error instanceof Error ? error.message : "Search API unavailable",
          tookMs: Math.round(performance.now() - startedAt),
          total: 0,
          totalRelation: "eq",
          enhancements: { querqy: "skipped", rules: [] },
        });
      });

    return () => controller.abort();
  }, [activePersona, activeQuery, filters, localPersonalizationPlan, localPlan, maxPrice, mode, queryUnderstandingEnabled, requestKey, selectedPipeline, searchPersona.id, sort]);

  const trackEvent = (payload) => {
    if (!ubiQueryId || mode !== "results" || searchResponse.status !== "ready" || searchResponse.requestKey !== requestKey) return;
    recordUbiEvent({ queryId: ubiQueryId, persona: activePersona, ...payload });
    setUbiEvents(getRecentUbiEvents());
  };

  const openPersonaSelector = (returnFocusTarget) => {
    personaReturnFocusRef.current = returnFocusTarget;
    setPersonaSelectorOpen(true);
  };

  const closePersonaSelector = () => {
    setPersonaSelectorOpen(false);
    requestAnimationFrame(() => {
      if (personaReturnFocusRef.current?.isConnected) personaReturnFocusRef.current.focus();
    });
  };

  const toggleFavorite = (id, product, ordinal) => {
    const actionName = favorites.has(id) ? "unsave" : "save";
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (product) {
      trackEvent({
        actionName,
        object: product,
        ordinal,
        message: `${actionName} ${product.item_id}`,
      });
    }
  };

  const toggleFilter = (key, option) => {
    const selected = !filters[key].includes(option);
    setFilters((current) => {
      const exists = current[key].includes(option);
      return {
        ...current,
        [key]: exists ? current[key].filter((value) => value !== option) : [...current[key], option],
      };
    });
    trackEvent({
      actionName: "filter_apply",
      message: `${key}:${option}`,
      eventAttributes: { filter: { key, option, selected } },
    });
  };

  const changeSort = (option) => {
    setSort(option);
    trackEvent({
      actionName: "sort",
      message: option,
      eventAttributes: { sort: { option } },
    });
  };

  const openProduct = (product, ordinal) => {
    setSelectedProduct(product);
    trackEvent({
      actionName: "click",
      object: product,
      ordinal,
      message: `open ${product.item_id}`,
    });
  };

  const addToCart = (product) => {
    if (cart.some((item) => item.id === product.id)) {
      setSelectedProduct(null);
      setCartOpen(true);
      return;
    }

    setCart((current) => (
      current.some((item) => item.id === product.id) ? current : [...current, product]
    ));
    trackEvent({
      actionName: "add_to_cart",
      messageType: "CONVERSION",
      object: product,
      message: `add_to_cart ${product.item_id}`,
    });
    setSelectedProduct(null);
    setCartOpen(true);
  };

  const removeFromCart = (product) => {
    setCart((current) => current.filter((item) => item.id !== product.id));
    trackEvent({
      actionName: "remove_from_cart",
      object: product,
      message: `remove_from_cart ${product.item_id}`,
    });
  };

  const runSearch = (value = query) => {
    const normalized = value.trim() || "designer resale";
    const nextPlan = queryUnderstandingEnabled && activePersona.id !== "anonymous"
      ? createQueryUnderstanding(normalized, products)
      : createLiteralQueryPlan(normalized);
    setActiveQuery(normalized);
    setQuery(normalized);
    setMaxPrice(nextPlan.priceMax || DEFAULT_MAX_PRICE);
    setMode("results");
    setSearchOpen(false);
  };

  const openCategory = (category) => {
    setActiveQuery(category.toLowerCase());
    setFilters((current) => ({ ...current, category: [category === "Jewellery" ? "Jewellery" : category] }));
    setMode("results");
  };

  const selectPersona = (nextPersona) => {
    const previousPersona = activePersona;
    setActivePersona(nextPersona);
    closePersonaSelector();

    try {
      localStorage.setItem(PERSONA_STORAGE_KEY, nextPersona.id);
    } catch {
      // Persona persistence is a demo convenience and should not block the shopping flow.
    }

    if (ubiQueryId && previousPersona.id !== nextPersona.id) {
      recordUbiEvent({
        queryId: ubiQueryId,
        persona: previousPersona,
        actionName: "persona_select",
        message: `persona ${previousPersona.id} -> ${nextPersona.id}`,
        eventAttributes: {
          persona_selection: { from: previousPersona.id, to: nextPersona.id },
        },
      });
      setUbiEvents(getRecentUbiEvents());
    }
  };

  return (
    <div className="app-shell">
      <Header
        mode={mode}
        query={query}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        setQuery={setQuery}
        runSearch={runSearch}
        suggestions={suggestions}
        cartCount={cart.length}
        onOpenCart={() => setCartOpen(true)}
        persona={activePersona}
        queryUnderstandingEnabled={queryUnderstandingEnabled}
        onToggleQueryUnderstanding={() => setQueryUnderstandingEnabled((enabled) => !enabled)}
        agenticModels={agenticModels}
        selectedPipeline={selectedPipeline}
        onSelectPipeline={setSelectedPipeline}
        menuButtonRef={mobileMenuButtonRef}
        onOpenPersona={openPersonaSelector}
        setMode={setMode}
        setMobileNavOpen={setMobileNavOpen}
      />

      {mode === "home" ? (
        <HomePage
          onCategory={openCategory}
          onProduct={openProduct}
          favorites={favorites}
          toggleFavorite={toggleFavorite}
          query={query}
          setQuery={setQuery}
          runSearch={runSearch}
        />
      ) : (
        <ResultsPage
          activeQuery={activeQuery}
          activePlan={activePlan}
          products={sortedProducts}
          filters={filters}
          toggleFilter={toggleFilter}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          sort={sort}
          setSort={changeSort}
          favorites={favorites}
          toggleFavorite={toggleFavorite}
          onProduct={openProduct}
          ubiQueryId={ubiQueryId}
          ubiEvents={ubiEvents}
          searchMeta={searchResponse}
          onRetry={() => setSearchAttempt((attempt) => attempt + 1)}
          onEditSearch={() => setSearchOpen(true)}
          clearFilters={() => {
            setFilters({ category: [], condition: [], material: [], country: [] });
            setMaxPrice(DEFAULT_MAX_PRICE);
          }}
          setFilterDrawerOpen={setFilterDrawerOpen}
        />
      )}

      {personaSelectorOpen && (
        <PersonaModal
          persona={activePersona}
          onSelect={selectPersona}
          onClose={closePersonaSelector}
        />
      )}

      {mobileNavOpen && (
        <MobileNav
          persona={activePersona}
          queryUnderstandingEnabled={queryUnderstandingEnabled}
          onToggleQueryUnderstanding={() => setQueryUnderstandingEnabled((enabled) => !enabled)}
          onOpenPersona={() => openPersonaSelector(mobileMenuButtonRef.current)}
          onClose={() => setMobileNavOpen(false)}
          setMode={setMode}
          runSearch={runSearch}
        />
      )}

      {filterDrawerOpen && (
        <FilterDrawer
          onClose={() => setFilterDrawerOpen(false)}
          filters={filters}
          toggleFilter={toggleFilter}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          clearFilters={() => {
            setFilters({ category: [], condition: [], material: [], country: [] });
            setMaxPrice(DEFAULT_MAX_PRICE);
          }}
        />
      )}

      {cartOpen && (
        <CartDrawer
          items={cart}
          onClose={() => setCartOpen(false)}
          onRemove={removeFromCart}
          onProduct={(product) => {
            setCartOpen(false);
            openProduct(product);
          }}
          trackEvent={trackEvent}
        />
      )}

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          favorite={favorites.has(selectedProduct.id)}
          inCart={cart.some((item) => item.id === selectedProduct.id)}
          addToCart={addToCart}
          toggleFavorite={toggleFavorite}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

function Header({
  mode,
  query,
  searchOpen,
  setSearchOpen,
  setQuery,
  runSearch,
  suggestions,
  cartCount,
  onOpenCart,
  persona,
  queryUnderstandingEnabled,
  onToggleQueryUnderstanding,
  agenticModels,
  selectedPipeline,
  onSelectPipeline,
  menuButtonRef,
  onOpenPersona,
  setMode,
  setMobileNavOpen,
}) {
  return (
    <header className={`site-header ${searchOpen ? "is-searching" : ""}`}>
      <div className="header-main">
        <button
          ref={menuButtonRef}
          className="menu-button"
          type="button"
          aria-label="Open menu"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu size={22} />
        </button>
        {mode !== "home" && (
          <button className="search-trigger" type="button" onClick={() => setSearchOpen(true)}>
            <Search size={18} />
            <span>{query || "Search the collection"}</span>
          </button>
        )}
        <button className="brand-mark" type="button" onClick={() => setMode("home")}>
          <span className="brand-seal" aria-hidden="true">LT</span>
          <span className="brand-lockup">
            <strong>{BRAND_NAME}</strong>
            <small>Paris · found again</small>
          </span>
        </button>
        <div className="header-actions">
          <button
            className={`query-understanding-toggle ${queryUnderstandingEnabled ? "is-on" : "is-off"}`}
            type="button"
            role="switch"
            aria-checked={queryUnderstandingEnabled}
            aria-label="Query understanding"
            title="Understand intent and personalize results. Turn off to search your exact words."
            onClick={onToggleQueryUnderstanding}
          >
            <img
              className="agentic-toggle-mark"
              src="/assets/opensearch-mark.svg"
              alt=""
              aria-hidden="true"
            />
            <span>Query understanding</span>
            <i aria-hidden="true">{queryUnderstandingEnabled ? "On" : "Off"}</i>
          </button>
          {queryUnderstandingEnabled && persona.id !== "anonymous" && agenticModels && agenticModels.length > 0 && (
            <label className="agentic-model-picker">
              <span className="agentic-model-picker-label">Model</span>
              <select
                value={selectedPipeline}
                onChange={(event) => onSelectPipeline(event.target.value)}
                aria-label="Agentic Search model"
              >
                {agenticModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="persona-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-label={`Choose demo persona. Current persona: ${persona.name}`}
            onClick={(event) => onOpenPersona(event.currentTarget)}
          >
            <img className="persona-trigger-avatar" src={persona.image} alt="" />
            <span>{persona.id === "anonymous" ? "Demo persona" : persona.shortName}</span>
            <ChevronDown size={14} />
          </button>
          <button className="bag-button" type="button" aria-label={`Open bag, ${cartCount} items`} onClick={onOpenCart}>
            <ShoppingBag size={20} />
            {cartCount > 0 && <span>{cartCount}</span>}
          </button>
        </div>
      </div>
      <nav className="desktop-nav" aria-label="Primary">
        {navItems.map((item) => (
          <button key={item} type="button" onClick={() => runSearch(item === "New arrivals" ? "new in" : item)}>
            {item}
          </button>
        ))}
      </nav>
      {searchOpen && (
        <div className="search-panel">
          <div className="search-box">
            <Search size={18} />
            <input
              autoFocus
              value={query}
              aria-label="Search the collection"
              placeholder="Describe a piece..."
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
            {query && (
              <button type="button" className="plain-button" onClick={() => setQuery("")}>
                Clear
              </button>
            )}
            <button className="icon-button" type="button" aria-label="Close search" onClick={() => setSearchOpen(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="suggestions-grid">
            <section>
              <h3>{query ? `Suggestions for "${query}"` : "Popular searches"}</h3>
              <ul>
                {suggestions.map((item) => (
                  <li key={item}>
                    <button type="button" onClick={() => runSearch(item)}>
                      <Search size={14} />
                      <span>{item}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Brands</h3>
              <ul>
                {["Maison Aurelle", "Maison Bellune", "Casa Gilda", "Laurent Velin"].map((brand) => (
                  <li key={brand}>
                    <button type="button" onClick={() => runSearch(brand)}>
                      <span>{brand}</span>
                      <ChevronRight size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </header>
  );
}

function HomePage({ onCategory, onProduct, favorites, toggleFavorite, query, setQuery, runSearch }) {
  const previewProducts = products.slice(0, 2);
  const newArrivalProducts = products.slice(96, 104);

  return (
    <main className="home-page">
      <section className="home-hero">
        <div className="home-hero-copy">
          <p className="eyebrow">A private atlas of remarkable things</p>
          <h1>The one you were not looking for. Until now.</h1>
          <p className="hero-intro">
            Search by memory, mood or detail. La Trouvaille brings singular pieces into view without the endless scroll.
          </p>
          <form
            className="home-search"
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <Search size={20} />
            <input
              value={query}
              aria-label="Search the collection"
              placeholder="Try “gold watch”"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit">Search</button>
          </form>
        </div>
        <div className="home-showcase" aria-label="Featured listings">
          {previewProducts.map((product, index) => (
            <button
              key={product.id}
              className={`hero-product hero-product-${index + 1}`}
              type="button"
              onClick={() => onProduct(product, index + 1)}
            >
              <img src={product.image} alt={`${product.brand} ${product.title}`} />
              <span>
                <strong>{product.title}</strong>
                <b>{formatPrice(product.price)}</b>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="discovery-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Three doors into the collection</p>
            <h2>Begin with a feeling.</h2>
          </div>
        </div>
        <div className="discovery-grid">
          {discoveryEdits.map((edit) => (
            <button key={edit.title} type="button" className="discovery-card" onClick={() => runSearch(edit.query)}>
              <img src={edit.image} alt="" />
              <span>
                <strong>{edit.title}</strong>
                <small>{edit.meta}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="category-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">A shorter way through</p>
            <h2>Browse the collection.</h2>
          </div>
        </div>
        <div className="category-grid">
          {categoryTiles.map((category) => (
            <button key={category.label} type="button" className="category-tile" onClick={() => onCategory(category.label)}>
              <img src={category.img} alt="" />
              <span>{category.label}</span>
            </button>
          ))}
        </div>
      </section>

      <ProductCarousel
        title="Newly discovered"
        onViewAll={() => runSearch("new in")}
        items={newArrivalProducts}
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        onProduct={onProduct}
      />
      <footer className="home-footer">
        <p className="eyebrow">La Trouvaille</p>
        <h2>Less feed. More find.</h2>
        <p>Independent wardrobes, singular objects and search that listens before it sorts.</p>
      </footer>
    </main>
  );
}

function ResultsPage({
  activeQuery,
  activePlan,
  products,
  filters,
  toggleFilter,
  maxPrice,
  setMaxPrice,
  sort,
  setSort,
  favorites,
  toggleFavorite,
  onProduct,
  ubiQueryId,
  ubiEvents,
  searchMeta,
  clearFilters,
  setFilterDrawerOpen,
  onRetry,
  onEditSearch,
}) {
  const resultCount = searchMeta?.total ?? products.length;
  const activeFilterCount = Object.values(filters).reduce((sum, values) => sum + values.length, 0)
    + (maxPrice < DEFAULT_MAX_PRICE ? 1 : 0);

  return (
    <main className="results-page">
      <section className="results-toolbar">
        <div>
          <p className="eyebrow">Search results</p>
          <h1>{activeQuery}</h1>
          <p aria-live="polite">
            {searchMeta?.status === "error" ? "We could not load this selection."
              : searchMeta?.status === "loading" ? "Finding pieces for you..."
                : `${formatResultCount(resultCount, searchMeta?.totalRelation)} listings available now`}
          </p>
        </div>
      </section>

      {searchMeta?.status === "ready" && activePlan.queryUnderstanding?.status !== "bypassed" && (
        <section className="query-strip">
          <div className="query-intent">
            <Sparkles size={18} />
            <div>
              <span>{activePlan.intent}</span>
              <strong>{activePlan.rewritten}</strong>
            </div>
          </div>
          <div className="query-chips">
            {activePlan.chips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        </section>
      )}

      <UbiTelemetryPanel queryId={ubiQueryId} events={ubiEvents} searchMeta={searchMeta} />

      <div className="results-layout">
        <aside className="filters-sidebar">
          <FilterPanel
            filters={filters}
            toggleFilter={toggleFilter}
            maxPrice={maxPrice}
            setMaxPrice={setMaxPrice}
            clearFilters={clearFilters}
          />
        </aside>
        <section className="catalogue">
          <div className="catalogue-head">
            <button className="mobile-filter-button" type="button" onClick={() => setFilterDrawerOpen(true)}>
              <SlidersHorizontal size={18} />
              Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
            </button>
            <label className="sort-control">
              <span>Sort</span>
              <select aria-label="Sort results" value={sort} onChange={(event) => setSort(event.target.value)}>
                {SORT_OPTIONS.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
          </div>
          {searchMeta?.status === "loading" ? (
            <div className="empty-results" aria-live="polite">
              <h2>Finding your next discovery</h2>
              <p>Searching the collection for your selection.</p>
            </div>
          ) : searchMeta?.status === "error" ? (
            <div className="empty-results" role="alert">
              <h2>Search unavailable</h2>
              <p>We could not complete your search. Your query and filters are saved.</p>
              <button type="button" onClick={onRetry}>Try again</button>
              <details className="search-diagnostics">
                <summary>Technical details</summary>
                <p>{searchMeta.error || "The search service is unavailable."}</p>
              </details>
            </div>
          ) : products.length ? (
            <div className="product-grid">
              {products.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  ordinal={index + 1}
                  favorite={favorites.has(product.id)}
                  toggleFavorite={toggleFavorite}
                  onProduct={onProduct}
                  dense
                />
              ))}
            </div>
          ) : (
            <div className="empty-results" aria-live="polite">
              <h2>No matching pieces this time</h2>
              <p>{activeFilterCount ? "Try removing a filter or describing the piece more broadly." : "Try a different material, style or a broader description."}</p>
              <button type="button" onClick={activeFilterCount ? clearFilters : onEditSearch}>
                {activeFilterCount ? "Clear filters" : "Edit search"}
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function UbiTelemetryPanel({ queryId, events, searchMeta }) {
  const queryRecord = events.find((event) => event.type === "query" && event.query_id === queryId);
  const recentInteractions = events
    .filter((event) => event.type === "event" && event.query_id === queryId)
    .slice(0, 3);
  const recent = queryRecord ? [queryRecord, ...recentInteractions] : recentInteractions;
  const sourceLabel =
    searchMeta?.source === "opensearch"
      ? "OpenSearch"
      : searchMeta?.status === "error"
        ? "Unavailable"
        : "Pending";
  return (
    <section className="ubi-panel" aria-label="User behavior telemetry">
      <div>
        <span>UBI query</span>
        <strong>{queryId ? queryId.slice(0, 8) : "pending"}</strong>
        <small>
          {sourceLabel}
          {Number.isFinite(searchMeta?.tookMs) ? ` ${searchMeta.tookMs} ms` : ""}
        </small>
      </div>
      <ol>
        {recent.map((event) => {
          const isQuery = event.type === "query";
          const dslQuery =
            event.query_attributes?.query_plan?.dsl_query_json ??
            event.query_attributes?.query_plan?.dslQuery ??
            event.query_attributes?.query_plan?.agentic?.dslQuery;
          const tooltipId = isQuery ? `ubi-dsl-${event.query_id}` : undefined;
          return (
            <li key={`${event.timestamp}-${event.action_name || event.user_query}`}>
              <span>{event.action_name || "query"}</span>
              {isQuery ? (
                <div className="ubi-query-hover" tabIndex={0} aria-describedby={tooltipId}>
                  <b>{event.user_query || event.message}</b>
                  <div className="ubi-dsl-popup" id={tooltipId} role="tooltip">
                    <span>Actual OpenSearch DSL</span>
                    <pre>{formatDslQuery(dslQuery)}</pre>
                  </div>
                </div>
              ) : (
                <b>{event.event_attributes?.object?.object_id || event.message}</b>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function FilterDrawer({ onClose, ...filterProps }) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="mobile-filter-drawer" role="dialog" aria-modal="true" aria-label="Filters" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <h2>Refine your selection</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close filters"><X size={18} /></button>
        </div>
        <FilterPanel {...filterProps} />
        <div className="filter-drawer-footer"><button className="primary-button" type="button" onClick={onClose}>Show results</button></div>
      </aside>
    </div>
  );
}

function FilterPanel({ filters, toggleFilter, maxPrice, setMaxPrice, clearFilters }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState({ category: true });
  const activeCount = Object.values(filters).reduce((total, values) => total + values.length, 0) + (maxPrice < DEFAULT_MAX_PRICE ? 1 : 0);
  return (
    <div className="filter-panel">
      <div className="filter-title">
        <h2>Filters</h2>
        <button type="button" onClick={clearFilters} disabled={!activeCount}>
          Clear {activeCount ? `(${activeCount})` : ""}
        </button>
      </div>
      <div className="filter-group">
        <div className="filter-label">
          <span>Price</span>
          <strong>{formatPrice(maxPrice)}</strong>
        </div>
        <input
          type="range"
          aria-label="Maximum price"
          aria-valuetext={formatPrice(maxPrice)}
          min="100"
          max="20000"
          step="50"
          value={maxPrice}
          onChange={(event) => setMaxPrice(Number(event.target.value))}
        />
      </div>
      {filterGroups.map((group) => (
        <div className="filter-group" key={group.key}>
          <button className="accordion-row" type="button"
            aria-expanded={Boolean(expanded[group.key])}
            aria-controls={`${panelId}-${group.key}`}
            onClick={() => setExpanded((current) => ({ ...current, [group.key]: !current[group.key] }))}
          >
            <span>{group.label}{filters[group.key].length ? ` (${filters[group.key].length})` : ""}</span>
            <ChevronDown size={16} />
          </button>
          <div className="check-list" id={`${panelId}-${group.key}`} hidden={!expanded[group.key]}>
            {group.options.map((option) => (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={filters[group.key].includes(option)}
                  onChange={() => toggleFilter(group.key, option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductCarousel({ title, items, favorites, toggleFavorite, onProduct, onViewAll }) {
  return (
    <section className="carousel-section">
      <div className="section-head">
        <h2>{title}</h2>
        <button type="button" onClick={onViewAll}>
          View all
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="product-rail">
        {items.map((product, index) => (
          <ProductCard
            key={`${title}-${product.id}`}
            product={product}
            ordinal={index + 1}
            favorite={favorites.has(product.id)}
            toggleFavorite={toggleFavorite}
            onProduct={onProduct}
          />
        ))}
      </div>
    </section>
  );
}

function ProductCard({ product, favorite, toggleFavorite, onProduct, ordinal = 0, dense = false }) {
  return (
    <article className={`product-card ${dense ? "dense" : ""}`}>
      <button className="product-media" type="button" onClick={() => onProduct(product, ordinal)}>
        <img src={product.image} alt={`${product.brand} ${product.title}`} />
        <span className="badge">{product.badge}</span>
      </button>
      <button
        className={`favorite-button ${favorite ? "active" : ""}`}
        type="button"
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(product.id, product, ordinal)}
      >
        <Heart size={18} fill={favorite ? "currentColor" : "none"} />
      </button>
      <button className="product-copy" type="button" onClick={() => onProduct(product, ordinal)}>
        <strong>{product.brand}</strong>
        <span>{product.title}</span>
        <small>{product.size}</small>
        <span className="price-line">
          {product.oldPrice && <del>{formatPrice(product.oldPrice)}</del>}
          <b>{formatPrice(product.price)}</b>
        </span>
        <small>{product.country}</small>
      </button>
    </article>
  );
}

function PersonaModal({ persona, onSelect, onClose }) {
  const [draftPersonaId, setDraftPersonaId] = useState(persona.id);
  const draftPersona = getPersonaById(draftPersonaId);
  const dialogRef = useDialogFocus(onClose);

  const movePersonaSelection = (event, currentIndex) => {
    const directions = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    if (!directions[event.key]) return;
    event.preventDefault();
    const nextIndex = (currentIndex + directions[event.key] + personas.length) % personas.length;
    const nextPersona = personas[nextIndex];
    setDraftPersonaId(nextPersona.id);
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector(`input[value="${nextPersona.id}"]`)?.focus();
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className="persona-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="persona-modal-title"
      >
        <div className="persona-modal-head">
          <div>
            <p className="eyebrow">Demo identity</p>
            <h2 id="persona-modal-title">Who are you shopping as?</h2>
            <p>Choose a fictional profile to give searches and interactions a clear shopper context.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close persona selector"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="persona-options" role="radiogroup" aria-label="Demo personas">
          {personas.map((option, index) => {
            const selected = draftPersonaId === option.id;
            return (
              <label
                key={option.id}
                className={`persona-option ${selected ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="demo-persona"
                  value={option.id}
                  checked={selected}
                  onChange={() => setDraftPersonaId(option.id)}
                  onKeyDown={(event) => movePersonaSelection(event, index)}
                />
                <span className="persona-option-head">
                  <span className="persona-avatar" aria-hidden="true">
                    <img src={option.image} alt="" />
                  </span>
                  <span className="persona-identity">
                    <strong>{option.name}</strong>
                    <small>{option.archetype}</small>
                    <span>{option.demographics}</span>
                  </span>
                  <span className="persona-check" aria-hidden="true">
                    {selected && <Check size={17} />}
                  </span>
                </span>
                <span className="persona-detail">
                  <strong>Background</strong>
                  <span>{option.background}</span>
                </span>
                <span className="persona-detail">
                  <strong>Mental model</strong>
                  <span>{option.mentalModel}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="persona-modal-footer">
          <p>
            <strong>{draftPersona.archetype}</strong>
            Anonymous keeps the demo unprofiled; named personas are included in UBI records.
          </p>
          <button className="primary-button" type="button" onClick={() => onSelect(draftPersona)}>
            Continue as {draftPersona.shortName}
          </button>
        </div>
      </section>
    </div>
  );
}

function MobileNav({
  persona,
  queryUnderstandingEnabled,
  onToggleQueryUnderstanding,
  onOpenPersona,
  onClose,
  setMode,
  runSearch,
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="mobile-nav" role="dialog" aria-modal="true" aria-label="Navigation" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <strong>{BRAND_NAME}</strong>
          <button className="icon-button" type="button" aria-label="Close menu" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setMode("home");
            onClose();
          }}
        >
          Home
        </button>
        <button
          className="mobile-persona-trigger"
          type="button"
          onClick={() => {
            onClose();
            onOpenPersona();
          }}
        >
          <span>
            <small>Demo persona</small>
            <strong>{persona.id === "anonymous" ? "Anonymous" : persona.name}</strong>
          </span>
          <ChevronRight size={16} />
        </button>
        <button
          className="mobile-query-understanding-toggle"
          type="button"
          role="switch"
          aria-checked={queryUnderstandingEnabled}
          aria-label="Query understanding"
          title="Understand intent and personalize results. Turn off to search your exact words."
          onClick={onToggleQueryUnderstanding}
        >
          <span>
            <small>Search controls</small>
            <strong>Query understanding</strong>
          </span>
          <b>{queryUnderstandingEnabled ? "On" : "Off"}</b>
        </button>
        {navItems.map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => {
              runSearch(item === "New arrivals" ? "new in" : item);
              onClose();
            }}
          >
            {item}
          </button>
        ))}
      </aside>
    </div>
  );
}

function CartDrawer({ items, onClose, onRemove, onProduct, trackEvent }) {
  const dialogRef = useDialogFocus(onClose);
  const subtotal = items.reduce((total, item) => total + item.price, 0);

  return (
    <div className="drawer-backdrop cart-backdrop" onClick={onClose}>
      <aside ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} className="cart-drawer" onClick={(event) => event.stopPropagation()} aria-label="Shopping bag">
        <div className="cart-header">
          <div>
            <p className="eyebrow">Your selection</p>
            <h2>Shopping bag</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close bag" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="cart-empty">
            <ShoppingBag size={32} strokeWidth={1.4} />
            <h3>Your bag is empty</h3>
            <p>Each listing is one of a kind. Add a piece before someone else finds it.</p>
            <button className="secondary-button" type="button" onClick={onClose}>
              Continue shopping
            </button>
          </div>
        ) : (
          <>
            <div className="cart-items">
              {items.map((item) => (
                <article className="cart-item" key={item.id}>
                  <button className="cart-item-image" type="button" onClick={() => onProduct(item)}>
                    <img src={item.image} alt="" />
                  </button>
                  <div className="cart-item-copy">
                    <button type="button" onClick={() => onProduct(item)}>
                      <strong>{item.brand}</strong>
                      <span>{item.title}</span>
                    </button>
                    <small>One of a kind</small>
                    <div>
                      <b>{formatPrice(item.price)}</b>
                      <button type="button" onClick={() => onRemove(item)}>Remove</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <div className="cart-summary">
              <div>
                <span>Subtotal</span>
                <strong>{formatPrice(subtotal)}</strong>
              </div>
              <p>Shipping and taxes calculated at checkout.</p>
              <button
                className="primary-button"
                type="button"
                onClick={() => trackEvent({ actionName: "checkout_start", messageType: "CONVERSION", message: `checkout_start ${items.length} items` })}
              >
                Checkout
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function ProductModal({ product, favorite, inCart, addToCart, toggleFavorite, onClose }) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section ref={dialogRef} className="product-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="product-title" tabIndex={-1}>
        <button className="modal-close icon-button" type="button" aria-label="Close product" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="product-modal-body">
          <img src={product.image} alt={`${product.brand} ${product.title}`} />
          <div className="product-detail">
            <p className="eyebrow">{product.brand}</p>
            <h2 id="product-title">{product.title}</h2>
            <div className="detail-price">
              {product.oldPrice && <del>{formatPrice(product.oldPrice)}</del>}
              <strong>{formatPrice(product.price)}</strong>
            </div>
            <dl>
              <div>
                <dt>Condition</dt>
                <dd>{product.condition}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{product.size}</dd>
              </div>
              <div>
                <dt>Ships from</dt>
                <dd>{product.country}</dd>
              </div>
            </dl>
            <p className="product-material">{product.color} · {product.material}</p>
          </div>
        </div>
        <div className="detail-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => addToCart(product)}
          >
            {inCart ? "View in bag" : "Add to bag"}
          </button>
          <button className="secondary-button" type="button" onClick={() => toggleFavorite(product.id, product)}>
            <Heart size={18} fill={favorite ? "currentColor" : "none"} />
            {favorite ? "Saved" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
