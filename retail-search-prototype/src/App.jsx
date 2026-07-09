import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
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
import { createQueryUnderstanding, localSearchProducts } from "./lib/search.js";
import { getRecentUbiEvents, recordUbiEvent, recordUbiQuery } from "./lib/ubi.js";

const SEARCH_ENDPOINT = import.meta.env.VITE_SEARCH_ENDPOINT || "http://127.0.0.1:8790";
const BRAND_NAME = "La Trouvaille";
const DEFAULT_MAX_PRICE = 20000;
const SORT_OPTIONS = ["Recommended", "Newest", "Lowest price", "Price drop"];
const featuredSearches = ["formal watch", "chanel bag", "silk dress", "hermes birkin"];
const discoveryEdits = [
  {
    title: "Fine watches",
    query: "formal watch",
    image: "/assets/products/01-dress-watch.png",
    meta: "Dress watches, steel classics, collector references",
  },
  {
    title: "Occasion dresses",
    query: "silk dress",
    image: "/assets/products/05-silk-maxi-dress.png",
    meta: "Silk, linen, evening and summer pieces",
  },
  {
    title: "Investment bags",
    query: "hermes birkin",
    image: "/assets/products/04-black-shoulder-bag.png",
    meta: "Hermes, Chanel, Celine and daily carry icons",
  },
];
const homeStats = [
  ["2M", "unique listings"],
  ["7", "luxury departments"],
  ["Daily", "fresh listings"],
];

const formatPrice = (price) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price);

const formatResultCount = (count, relation) => {
  const formatted = Number(count || 0).toLocaleString("en-US");
  return relation === "gte" ? `${formatted}+` : formatted;
};

export function App() {
  const lastQuerySignature = useRef("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [mode, setMode] = useState("home");
  const [sort, setSort] = useState("Recommended");
  const [filters, setFilters] = useState({ category: [], condition: [], material: [], country: [] });
  const [maxPrice, setMaxPrice] = useState(DEFAULT_MAX_PRICE);
  const [favorites, setFavorites] = useState(new Set(["MR-0000001", "MR-0000009"]));
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showPreference, setShowPreference] = useState(false);
  const [preference, setPreference] = useState("Womenswear");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [ubiQueryId, setUbiQueryId] = useState("");
  const [ubiEvents, setUbiEvents] = useState(() => getRecentUbiEvents().slice(0, 6));
  const [searchResponse, setSearchResponse] = useState({
    products: null,
    source: "local",
    status: "idle",
    tookMs: null,
    total: products.length,
    totalRelation: "eq",
    enhancements: { querqy: "not_called", rules: [] },
  });

  const activePlan = useMemo(() => createQueryUnderstanding(activeQuery, products), [activeQuery]);
  const suggestions = useMemo(() => {
    const seed = query.trim().toLowerCase();
    if (!seed) return popularSearches.slice(0, 6);
    return popularSearches.filter((item) => item.includes(seed)).slice(0, 6);
  }, [query]);

  const localProducts = useMemo(
    () => localSearchProducts(products, { query: activeQuery, filters, maxPrice, sort }),
    [activeQuery, filters, maxPrice, sort],
  );
  const sortedProducts = searchResponse.products ?? localProducts;

  useEffect(() => {
    if (mode !== "results") return undefined;
    const controller = new AbortController();
    const startedAt = performance.now();
    setSearchResponse({
      products: localProducts,
      source: "local",
      status: "loading",
      tookMs: null,
      total: localProducts.length,
      totalRelation: "eq",
      enhancements: { querqy: "not_called", rules: [] },
    });

    fetch(`${SEARCH_ENDPOINT}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: activeQuery, filters, maxPrice, sort, size: 96 }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Search API returned ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSearchResponse({
          products: payload.products || [],
          source: payload.source || "opensearch",
          status: payload.source === "local-fallback" ? "degraded" : "ready",
          tookMs: payload.tookMs ?? Math.round(performance.now() - startedAt),
          total: payload.total ?? payload.products?.length ?? 0,
          totalRelation: payload.totalRelation || "eq",
          enhancements: payload.enhancements || { querqy: "not_called", rules: [] },
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSearchResponse({
          products: localProducts,
          source: "local",
          status: "degraded",
          tookMs: Math.round(performance.now() - startedAt),
          total: localProducts.length,
          totalRelation: "eq",
          enhancements: { querqy: "skipped", rules: [] },
        });
      });

    return () => controller.abort();
  }, [activeQuery, filters, localProducts, maxPrice, mode, sort]);

  useEffect(() => {
    if (mode !== "results") return;
    if (searchResponse.status === "idle" || searchResponse.status === "loading") return;
    const signature = JSON.stringify({ activeQuery, filters, maxPrice, sort });
    if (lastQuerySignature.current === signature) return;
    lastQuerySignature.current = signature;

    const queryRecord = recordUbiQuery({
      userQuery: activeQuery,
      rewrittenQuery: activePlan.rewritten,
      queryPlan: {
        ...activePlan,
        source: searchResponse.source,
        took_ms: searchResponse.tookMs,
        tier2: searchResponse.enhancements,
      },
      results: sortedProducts.slice(0, 24),
      filters,
      sort,
    });
    setUbiQueryId(queryRecord.query_id);
    setUbiEvents(getRecentUbiEvents().slice(0, 6));
  }, [activePlan, activeQuery, filters, maxPrice, mode, searchResponse.source, searchResponse.status, searchResponse.tookMs, sort, sortedProducts]);

  const trackEvent = (payload) => {
    if (!ubiQueryId) return;
    recordUbiEvent({ queryId: ubiQueryId, ...payload });
    setUbiEvents(getRecentUbiEvents().slice(0, 6));
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

  const runSearch = (value = query) => {
    const normalized = value.trim() || "designer resale";
    const nextPlan = createQueryUnderstanding(normalized, products);
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

  return (
    <div className="app-shell">
      <Header
        query={query}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        setQuery={setQuery}
        runSearch={runSearch}
        suggestions={suggestions}
        favoritesCount={favorites.size}
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
          clearFilters={() => {
            setFilters({ category: [], condition: [], material: [], country: [] });
            setMaxPrice(DEFAULT_MAX_PRICE);
          }}
          setFilterDrawerOpen={setFilterDrawerOpen}
        />
      )}

      {showPreference && (
        <PreferenceModal
          preference={preference}
          setPreference={setPreference}
          onClose={() => setShowPreference(false)}
        />
      )}

      {mobileNavOpen && <MobileNav onClose={() => setMobileNavOpen(false)} setMode={setMode} />}

      {filterDrawerOpen && (
        <div className="drawer-backdrop" onClick={() => setFilterDrawerOpen(false)}>
          <aside className="mobile-filter-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h2>Filters</h2>
              <button className="icon-button" type="button" onClick={() => setFilterDrawerOpen(false)} aria-label="Close filters">
                <X size={18} />
              </button>
            </div>
            <FilterPanel
              filters={filters}
              toggleFilter={toggleFilter}
              maxPrice={maxPrice}
              setMaxPrice={setMaxPrice}
              clearFilters={() => {
                setFilters({ category: [], condition: [], material: [], country: [] });
                setMaxPrice(DEFAULT_MAX_PRICE);
              }}
            />
          </aside>
        </div>
      )}

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          favorite={favorites.has(selectedProduct.id)}
          toggleFavorite={toggleFavorite}
          trackEvent={trackEvent}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

function Header({
  query,
  searchOpen,
  setSearchOpen,
  setQuery,
  runSearch,
  suggestions,
  favoritesCount,
  setMode,
  setMobileNavOpen,
}) {
  return (
    <header className={`site-header ${searchOpen ? "is-searching" : ""}`}>
      <a className="top-strip" href="#seller">
        Ready to sell? Enjoy zero selling fees on your first listing.
      </a>
      <div className="header-main">
        <button className="menu-button" type="button" aria-label="Open menu" onClick={() => setMobileNavOpen(true)}>
          <Menu size={22} />
        </button>
        <button className="search-trigger" type="button" onClick={() => setSearchOpen(true)}>
          <Search size={18} />
          <span>{query || "Search by brand, article..."}</span>
        </button>
        <button className="brand-mark" type="button" onClick={() => setMode("home")}>
          {BRAND_NAME}
        </button>
        <div className="header-actions">
          <a className="sell-link" href="#seller">
            Sell an item
          </a>
          <button type="button">Sign in</button>
          <button type="button">Sign up</button>
          <button className="icon-button" type="button" aria-label="Notifications">
            <Bell size={18} />
          </button>
          <button className="bag-button" type="button" aria-label={`${favoritesCount} saved items`}>
            <ShoppingBag size={20} />
            <span>{favoritesCount}</span>
          </button>
        </div>
      </div>
      <nav className="desktop-nav" aria-label="Primary">
        {navItems.map((item) => (
          <a key={item} href={`#${item.toLowerCase().replaceAll(" ", "-")}`}>
            {item}
          </a>
        ))}
      </nav>
      {searchOpen && (
        <div className="search-panel">
          <div className="search-box">
            <Search size={18} />
            <input
              autoFocus
              value={query}
              placeholder="Search by brand, article..."
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
                {["Cartier", "Chanel", "Gucci", "Saint Laurent"].map((brand) => (
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
  const previewProducts = products.slice(0, 6);
  const newArrivalProducts = products.slice(96, 104);

  return (
    <main className="home-page">
      <section className="home-hero">
        <div className="home-hero-copy">
          <p className="eyebrow">Pre-loved luxury search</p>
          <h1>Find the exact piece, not a generic product page.</h1>
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
              placeholder="Search brand, item, style..."
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit">Search</button>
          </form>
          <div className="home-searches" aria-label="Featured searches">
            {featuredSearches.map((item) => (
              <button key={item} type="button" onClick={() => runSearch(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="home-stats" aria-label="Marketplace scale">
            {homeStats.map(([value, label]) => (
              <span key={label}>
                <strong>{value}</strong>
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="home-showcase" aria-label="Featured listings">
          {previewProducts.map((product, index) => (
            <button key={product.id} type="button" onClick={() => onProduct(product, index + 1)}>
              <img src={product.image} alt={`${product.brand} ${product.title}`} />
              <span>
                <strong>{product.brand}</strong>
                {formatPrice(product.price)}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-promo">
        <div>
          <h2>Up to 250 EUR off first 3 orders</h2>
          <p>Use code NEW10 and unlock better ones as you go.</p>
        </div>
        <button type="button" onClick={() => runSearch("new in")}>
          Shop new in
          <ArrowRight size={16} />
        </button>
      </section>

      <section className="discovery-section">
        <div className="section-head">
          <h2>Curated starting points</h2>
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
          <h2>Shop by category</h2>
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

      <section className="editorial-band">
        <div>
          <h2>Summer in the city</h2>
          <p>Dresses, sandals, sunglasses and compact bags selected for warm evenings.</p>
        </div>
        <div className="editorial-links">
          {["Dresses", "Tops", "Sunglasses", "Sandals", "Bags"].map((item) => (
            <button key={item} type="button" onClick={() => runSearch(item)}>
              {item}
            </button>
          ))}
        </div>
      </section>

      <ProductCarousel
        title="Recently listed"
        items={newArrivalProducts}
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        onProduct={onProduct}
      />
      <ProductCarousel
        title="Now trending"
        items={[...products].reverse().slice(0, 8)}
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        onProduct={onProduct}
      />
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
}) {
  const resultCount = searchMeta?.total ?? products.length;
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const chooseSort = (option) => {
    setSort(option);
    setSortMenuOpen(false);
  };

  return (
    <main className="results-page">
      <section className="results-toolbar">
        <div>
          <p className="eyebrow">Search results</p>
          <h1>{activeQuery}</h1>
          <p>{formatResultCount(resultCount, searchMeta?.totalRelation)} unique items available now</p>
        </div>
        <button className="mobile-filter-button" type="button" onClick={() => setFilterDrawerOpen(true)}>
          <SlidersHorizontal size={18} />
          Filters
        </button>
      </section>

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
            <div className="sort-row" aria-label="Sort results">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={sort === option ? "active" : ""}
                  type="button"
                  onClick={() => chooseSort(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="sort-menu-wrap">
              <button
                className="sort-menu"
                type="button"
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
                onClick={() => setSortMenuOpen((open) => !open)}
              >
                Sort: {sort}
                <ChevronDown size={16} />
              </button>
              {sortMenuOpen && (
                <div className="sort-popover" role="menu" aria-label="Sort options">
                  {SORT_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sort === option}
                      className={sort === option ? "active" : ""}
                      onClick={() => chooseSort(option)}
                    >
                      <span>{option}</span>
                      {sort === option && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {products.length ? (
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
            <div className="empty-results">
              <h2>No matching items</h2>
              <p>Try a broader query or clear a filter.</p>
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function UbiTelemetryPanel({ queryId, events, searchMeta }) {
  const recent = events.slice(0, 4);
  const sourceLabel = searchMeta?.source === "opensearch" ? "OpenSearch" : "Local fallback";
  const tier2 = searchMeta?.enhancements?.querqy || "not_called";
  const rules = searchMeta?.enhancements?.rules || [];
  return (
    <section className="ubi-panel" aria-label="User behavior telemetry">
      <div>
        <span>UBI query</span>
        <strong>{queryId ? queryId.slice(0, 8) : "pending"}</strong>
        <small>
          {sourceLabel}
          {Number.isFinite(searchMeta?.tookMs) ? ` ${searchMeta.tookMs} ms` : ""}
        </small>
        <small>
          Querqy {tier2}
          {rules.length ? `: ${rules.slice(0, 2).join(", ")}` : ""}
        </small>
      </div>
      <ol>
        {recent.map((event) => (
          <li key={`${event.timestamp}-${event.action_name || event.user_query}`}>
            <span>{event.action_name || "query"}</span>
            <b>{event.event_attributes?.object?.object_id || event.user_query || event.message}</b>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FilterPanel({ filters, toggleFilter, maxPrice, setMaxPrice, clearFilters }) {
  const activeCount = Object.values(filters).reduce((total, values) => total + values.length, 0);
  return (
    <div className="filter-panel">
      <div className="filter-title">
        <h2>Filters</h2>
        <button type="button" onClick={clearFilters}>
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
          min="100"
          max="20000"
          step="50"
          value={maxPrice}
          onChange={(event) => setMaxPrice(Number(event.target.value))}
        />
      </div>
      {filterGroups.map((group) => (
        <div className="filter-group" key={group.key}>
          <button className="accordion-row" type="button">
            <span>{group.label}</span>
            <ChevronDown size={16} />
          </button>
          <div className="check-list">
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

function ProductCarousel({ title, items, favorites, toggleFavorite, onProduct }) {
  return (
    <section className="carousel-section">
      <div className="section-head">
        <h2>{title}</h2>
        <button type="button">
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

function PreferenceModal({ preference, setPreference, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="preference-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h2>Select shopping preference</h2>
        <p>Personalize your homepage to get started.</p>
        {["Womenswear", "Menswear"].map((option) => (
          <button
            type="button"
            key={option}
            className={`preference-option ${preference === option ? "selected" : ""}`}
            onClick={() => setPreference(option)}
          >
            <span>{option}</span>
            {preference === option && <Check size={18} />}
          </button>
        ))}
        <button className="primary-button" type="button" onClick={onClose}>
          Continue
        </button>
      </section>
    </div>
  );
}

function MobileNav({ onClose, setMode }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="mobile-nav" onClick={(event) => event.stopPropagation()}>
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
        {navItems.map((item) => (
          <a href={`#${item}`} key={item} onClick={onClose}>
            {item}
          </a>
        ))}
      </aside>
    </div>
  );
}

function ProductModal({ product, favorite, toggleFavorite, trackEvent, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="product-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close icon-button" type="button" aria-label="Close product" onClick={onClose}>
          <X size={18} />
        </button>
        <img src={product.image} alt={`${product.brand} ${product.title}`} />
        <div className="product-detail">
          <span className="badge inline">{product.badge}</span>
          <h2>{product.brand}</h2>
          <p>{product.title}</p>
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
          <div className="reason-list">
            {product.reasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
          </div>
          <div className="detail-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() =>
                trackEvent({
                  actionName: "add_to_cart",
                  messageType: "CONVERSION",
                  object: product,
                  message: `add_to_cart ${product.item_id}`,
                })
              }
            >
              Add to bag
            </button>
            <button className="secondary-button" type="button" onClick={() => toggleFavorite(product.id, product)}>
              <Heart size={18} fill={favorite ? "currentColor" : "none"} />
              {favorite ? "Saved" : "Save"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
