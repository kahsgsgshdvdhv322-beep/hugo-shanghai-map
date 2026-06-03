const markerLayer = document.querySelector("#marker-layer");
const detailPanel = document.querySelector("#detail-panel");
const tabButtons = document.querySelectorAll(".tab-button");
const searchInput = document.querySelector("#place-search");
const filterStrip = document.querySelector(".filter-strip");
const marketStatusButtons = document.querySelectorAll("[data-market-status]");
const appConfig = window.HUGO_CONFIG || {};

let amap = null;
let amapMarkers = [];
let currentZoom = 14.35;
let renderTimer = null;
let searchFitTimer = null;
let currentCenter = null;
let suppressMapDismissUntil = 0;
let isMapZooming = false;

const data = window.HUGO_DATA || { markets: [], cafes: [] };

let activeCategory = "all";
let activeItemId = null;
let activeMarketStatus = "all";
const viewedIds = new Set(JSON.parse(localStorage.getItem("hugo-viewed") || "[]"));
const SHANGHAI_CENTER = [121.4908, 31.2208];
const DEFAULT_ZOOM = 14.35;
const VIEWPORT_PADDING_RATIO = 0.08;
const MAX_RENDERED_MARKERS = 420;
const DEFAULT_CAFE_MIN_SCORE = 4.5;

function saveViewedIds() {
  localStorage.setItem("hugo-viewed", JSON.stringify([...viewedIds]));
}

function getMarketStatus(item, now = Date.now()) {
  const startsAt = new Date(item.startsAt).getTime();
  const endsAt = new Date(item.endsAt).getTime();
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt) || now > endsAt) return "ended";
  if (now < startsAt) return "upcoming";
  return "ongoing";
}

function getActiveItems() {
  const query = searchInput.value.trim().toLowerCase();
  const now = Date.now();

  const sourceItems =
    activeCategory === "all" ? [...data.markets, ...data.cafes] : data[activeCategory];

  return sourceItems.filter((item) => {
    if (item.coordinateStatus === "sample") {
      return false;
    }

    if (item.category === "markets") {
      const marketStatus = getMarketStatus(item, now);
      if (marketStatus === "ended") {
        return false;
      }
      if (
        activeCategory === "markets" &&
        activeMarketStatus !== "all" &&
        marketStatus !== activeMarketStatus
      ) {
        return false;
      }
    }

    if (item.category === "cafes" && !item.isOpen) {
      return false;
    }

    if (item.category === "cafes" && Number(item.score) < DEFAULT_CAFE_MIN_SCORE) {
      return false;
    }

    const fields =
      item.category === "markets"
        ? [item.name, item.place, item.time, item.intro]
        : [item.name, item.address, item.hours, item.tags.join(" ")];
    return fields.join(" ").toLowerCase().includes(query);
  });
}

function scheduleRenderMarkers() {
  if (isMapZooming) return;

  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderMarkers, 80);
}

function scheduleRenderMarkersAfterZoom() {
  isMapZooming = false;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderMarkers, 140);
}

function readLngLat(lnglat) {
  if (!lnglat) return null;

  if (Array.isArray(lnglat)) return lnglat;

  const lng = typeof lnglat.getLng === "function" ? lnglat.getLng() : lnglat.lng;
  const lat = typeof lnglat.getLat === "function" ? lnglat.getLat() : lnglat.lat;
  if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];

  if (typeof lnglat.toString === "function") {
    const values = lnglat
      .toString()
      .split(",")
      .map((value) => Number(value.trim()));
    if (values.length >= 2 && values.every(Number.isFinite)) return values.slice(0, 2);
  }

  return null;
}

function syncMapState() {
  if (!amap) return;

  currentZoom = amap.getZoom();
  currentCenter = readLngLat(amap.getCenter()) || currentCenter || SHANGHAI_CENTER;
}

function isItemInMapView(item) {
  if (!amap || !window.AMap || !item.lnglat) return true;
  if (item.id === activeItemId) return true;

  const bounds = readMapBounds();
  if (!bounds) return true;

  return (
    item.lnglat[0] >= bounds.minLng &&
    item.lnglat[0] <= bounds.maxLng &&
    item.lnglat[1] >= bounds.minLat &&
    item.lnglat[1] <= bounds.maxLat
  );
}

function readMapBounds() {
  if (!amap || typeof amap.getBounds !== "function") return null;

  const bounds = amap.getBounds();
  const southWest = readLngLat(
    typeof bounds.getSouthWest === "function" ? bounds.getSouthWest() : bounds.southWest
  );
  const northEast = readLngLat(
    typeof bounds.getNorthEast === "function" ? bounds.getNorthEast() : bounds.northEast
  );
  if (!southWest || !northEast) return null;

  const lngPadding = Math.abs(northEast[0] - southWest[0]) * VIEWPORT_PADDING_RATIO;
  const latPadding = Math.abs(northEast[1] - southWest[1]) * VIEWPORT_PADDING_RATIO;
  return {
    minLng: Math.min(southWest[0], northEast[0]) - lngPadding,
    maxLng: Math.max(southWest[0], northEast[0]) + lngPadding,
    minLat: Math.min(southWest[1], northEast[1]) - latPadding,
    maxLat: Math.max(southWest[1], northEast[1]) + latPadding,
  };
}

function zoomForBounds(lngSpan, latSpan) {
  const mapRect = document.querySelector("#amap-map").getBoundingClientRect();
  const paddedLngSpan = Math.max(lngSpan * 1.8, 0.01);
  const paddedLatSpan = Math.max(latSpan * 1.8, 0.008);
  const lngZoom = Math.log2((mapRect.width * 360) / (256 * paddedLngSpan));
  const latZoom = Math.log2((mapRect.height * 360) / (256 * paddedLatSpan));
  const targetZoom = Math.min(lngZoom, latZoom);
  return Math.max(11.2, Math.min(15.8, targetZoom));
}

function moveMapToItems(items) {
  if (!amap || !items.length) return;

  const lnglats = items.map((item) => item.lnglat).filter(Boolean);
  if (!lnglats.length) return;

  const lngs = lnglats.map((lnglat) => lnglat[0]);
  const lats = lnglats.map((lnglat) => lnglat[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const center = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const targetZoom = lnglats.length === 1 ? 15.2 : zoomForBounds(maxLng - minLng, maxLat - minLat);

  if (typeof amap.setZoomAndCenter === "function") {
    amap.setZoomAndCenter(targetZoom, center);
  } else {
    amap.setZoom(targetZoom);
    amap.setCenter(center);
  }

  currentZoom = targetZoom;
  currentCenter = center;
  scheduleRenderMarkers();
}

function scheduleFitSearchResults() {
  window.clearTimeout(searchFitTimer);
  searchFitTimer = window.setTimeout(() => {
    const query = searchInput.value.trim();
    if (!query) return;
    moveMapToItems(getActiveItems());
  }, 180);
}

function maxRenderedMarkersForZoom() {
  if (currentZoom >= 15) return 180;
  if (currentZoom >= 13.6) return 130;
  return MAX_RENDERED_MARKERS;
}

function getVisibleMapItems(items) {
  if (!amap) return items;
  const maxRenderedMarkers = maxRenderedMarkersForZoom();

  if (items.length <= maxRenderedMarkers) return items;

  const visibleItems = items.filter(isItemInMapView);
  if (visibleItems.length <= maxRenderedMarkers) return visibleItems;

  return [...visibleItems]
    .sort((a, b) => {
      if (a.id === activeItemId) return -1;
      if (b.id === activeItemId) return 1;
      return markerPriority(a) - markerPriority(b) || distanceFromMapCenter(a) - distanceFromMapCenter(b);
    })
    .slice(0, maxRenderedMarkers);
}

function markerMeta(item) {
  if (item.category === "cafes") {
    return `${item.score} 分`;
  }
  return item.mapTime;
}

function markerTitle(name) {
  return name.length > 8 ? `${name.slice(0, 8)}...` : name;
}

function markerIcon(category) {
  if (category === "cafes") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 8h11v6.2A3.8 3.8 0 0 1 12.2 18H8.8A3.8 3.8 0 0 1 5 14.2V8Z"></path>
        <path d="M16 10h1.4a2.1 2.1 0 0 1 0 4.2H16"></path>
        <path d="M7 21h9"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 21V5"></path>
      <path d="M6 5h10.5l-1.7 3 1.7 3H6"></path>
    </svg>
  `;
}

function isSpecificLink(url) {
  if (!url) return false;

  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace(/\/+$/, "");
    return path && path !== "";
  } catch {
    return false;
  }
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function isNewToday(item) {
  const firstSeenAt = new Date(item.firstSeenAt).getTime();
  return !Number.isNaN(firstSeenAt) && firstSeenAt >= startOfToday();
}

function buildMarkerHtml(item, positionStyle = "", isDotMarker = false) {
  const shouldShowNewDot = isNewToday(item) && !viewedIds.has(item.id);
  const activeClass = item.id === activeItemId ? "is-active" : "";
  const dotClass = isDotMarker ? "is-dot-marker" : "";

  return `
    <button
      class="place-marker ${activeClass} ${dotClass}"
      data-id="${item.id}"
      data-category="${item.category}"
      style="${positionStyle}"
      type="button"
      aria-label="查看${item.name}"
    >
      <span class="marker-icon" aria-hidden="true">${markerIcon(item.category)}</span>
      <span class="marker-copy">
        <span class="marker-title">${markerTitle(item.name)}</span>
        <span class="marker-meta">${markerMeta(item)}</span>
      </span>
      <span class="marker-pin-dot" aria-hidden="true"></span>
      ${shouldShowNewDot ? '<span class="unread-dot" aria-hidden="true"></span>' : ""}
    </button>
  `;
}

function renderMockMarkers(items) {
  markerLayer.innerHTML = items
    .map((item) => buildMarkerHtml(item, `left: ${item.x}%; top: ${item.y}%`))
    .join("");

  markerLayer.querySelectorAll(".place-marker").forEach((marker) => {
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      suppressMapDismiss();
      selectItem(marker.dataset.id);
    });
  });
}

function markerPriority(item) {
  const categoryRank = item.category === "markets" ? 0 : 1;
  const endTime =
    item.category === "markets" ? new Date(item.endsAt).getTime() : Number.MAX_SAFE_INTEGER;
  const safeEndTime = Number.isNaN(endTime) ? Number.MAX_SAFE_INTEGER : endTime;
  return categoryRank * 1_000_000_000_000 + safeEndTime;
}

function distanceFromMapCenter(item) {
  const center = currentCenter || SHANGHAI_CENTER;
  const lngDelta = item.lnglat[0] - center[0];
  const latDelta = item.lnglat[1] - center[1];
  return lngDelta * lngDelta + latDelta * latDelta;
}

function pixelFromLngLat(lnglat) {
  if (!amap || !window.AMap) return null;

  const pixel = amap.lngLatToContainer(new window.AMap.LngLat(lnglat[0], lnglat[1]));
  return {
    x: typeof pixel.getX === "function" ? pixel.getX() : pixel.x,
    y: typeof pixel.getY === "function" ? pixel.getY() : pixel.y,
  };
}

function shouldCollapseMarker(item, expandedMarkers) {
  if (item.id === activeItemId) return false;
  if (currentZoom < 13.2) return true;
  if (currentZoom >= 15.4) return false;

  const pixel = pixelFromLngLat(item.lnglat);
  if (!pixel) return false;

  const collisionWidth = currentZoom >= 14.4 ? 96 : 138;
  const collisionHeight = currentZoom >= 14.4 ? 34 : 48;

  return expandedMarkers.some((expandedItem) => {
    const expandedPixel = pixelFromLngLat(expandedItem.lnglat);
    if (!expandedPixel) return false;

    return (
      Math.abs(pixel.x - expandedPixel.x) < collisionWidth &&
      Math.abs(pixel.y - expandedPixel.y) < collisionHeight
    );
  });
}

function getDotMarkerIds(items) {
  const expandedMarkers = [];
  const dotMarkerIds = new Set();
  const sortedItems = [...items].sort((a, b) => markerPriority(a) - markerPriority(b));

  sortedItems.forEach((item) => {
    if (shouldCollapseMarker(item, expandedMarkers)) {
      dotMarkerIds.add(item.id);
      return;
    }

    expandedMarkers.push(item);
  });

  return dotMarkerIds;
}

function renderAmapMarkers(items) {
  if (!amap || !window.AMap) return;

  amapMarkers.forEach((marker) => marker.setMap(null));
  amapMarkers = [];
  markerLayer.innerHTML = "";
  syncMapState();
  const visibleItems = getVisibleMapItems(items);
  const dotMarkerIds = getDotMarkerIds(visibleItems);

  visibleItems.forEach((item) => {
    const markerElement = document.createElement("div");
    markerElement.className = "amap-marker-wrap";
    markerElement.innerHTML = buildMarkerHtml(item, "", dotMarkerIds.has(item.id));

    const markerButton = markerElement.querySelector(".place-marker");
    markerButton.classList.add("amap-place-marker");
    markerButton.addEventListener("click", (event) => {
      event.stopPropagation();
      suppressMapDismiss();
      selectItem(item.id);
    });

    const marker = new window.AMap.Marker({
      anchor: "center",
      content: markerElement,
      position: item.lnglat,
      zIndex: item.id === activeItemId ? 120 : 100,
    });

    amap.add(marker);
    amapMarkers.push(marker);
  });

}

function renderMarkers() {
  const items = getActiveItems();

  if (!items.some((item) => item.id === activeItemId)) activeItemId = null;

  if (amap) {
    renderAmapMarkers(items);
    return;
  }

  renderMockMarkers(items);
}

function renderMarketDetail(item) {
  const sourceButton = isSpecificLink(item.sourceLink)
    ? `<a class="source-button" href="${item.sourceLink}" target="_blank" rel="noreferrer">查看信息来源</a>`
    : "";
  const cover = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${item.name}宣传图" />`
    : `
      <div class="cover-art ${item.imageStyle}" role="img" aria-label="${item.name}宣传图">
        <span class="sun"></span>
        <span class="awning"></span>
        <span class="stall"></span>
        <span class="flag"></span>
      </div>
    `;

  detailPanel.innerHTML = `
    <div class="detail-cover">
      ${cover}
    </div>
    <div class="detail-body">
      <div class="detail-kicker">
        <span>集市</span>
        <span>更新 ${item.updatedAt}</span>
      </div>
      <h1 class="detail-title">${item.name}</h1>
      <div class="detail-line">
        <span>举办地点</span>
        <strong>${item.place}</strong>
      </div>
      <div class="detail-line">
        <span>举办时间</span>
        <strong>${item.time}</strong>
      </div>
      <div class="detail-line">
        <span>一句话介绍</span>
        <p>${item.intro}</p>
      </div>
      ${sourceButton}
    </div>
  `;
}

function renderCafeDetail(item) {
  const reviewButton = isSpecificLink(item.link)
    ? `<a class="source-button" href="${item.link}" target="_blank" rel="noreferrer">查看大众点评评价</a>`
    : "";
  const cover = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${item.name}咖啡店图" />`
    : `
      <div class="cover-art ${item.imageStyle}" role="img" aria-label="${item.name}咖啡店图">
        <span class="steam"></span>
        <span class="cup"></span>
        <span class="counter"></span>
      </div>
    `;

  detailPanel.innerHTML = `
    <div class="detail-cover">
      ${cover}
    </div>
    <div class="detail-body">
      <div class="detail-kicker">
        <span>咖啡店</span>
      </div>
      <h1 class="detail-title">${item.name}</h1>
      <div class="score-badge">
        <span>评分</span>
        <strong>${item.score}</strong>
        <span>/ 5.0</span>
      </div>
      <div class="detail-line">
        <span>营业时间</span>
        <strong>${item.hours}</strong>
      </div>
      <div class="detail-line">
        <span>地址</span>
        <strong>${item.address}</strong>
      </div>
      <div class="detail-line">
        <span>适合</span>
        <div class="tag-row">${item.tags.map((tag) => `<span>${tag}</span>`).join("")}</div>
      </div>
      ${reviewButton}
    </div>
  `;
}

function renderDetail(item) {
  if (!item) {
    detailPanel.classList.remove("is-open");
    detailPanel.innerHTML = "";
    return;
  }

  detailPanel.classList.add("is-open");

  if (item.category === "markets") {
    renderMarketDetail(item);
  } else {
    renderCafeDetail(item);
  }
}

function closeDetail() {
  if (!activeItemId) return;

  activeItemId = null;
  renderDetail(null);
  renderMarkers();
}

function suppressMapDismiss() {
  suppressMapDismissUntil = Date.now() + 350;
}

function closeDetailFromMap() {
  if (Date.now() < suppressMapDismissUntil) return;
  closeDetail();
}

function selectItem(id) {
  const item = [...data.markets, ...data.cafes].find((entry) => entry.id === id);
  if (!item) return;

  activeItemId = id;
  viewedIds.add(id);
  saveViewedIds();
  renderDetail(item);
  renderMarkers();
}

function switchCategory(category) {
  if (activeCategory === category) {
    activeCategory = "all";
    activeItemId = null;
    activeMarketStatus = "all";
    marketStatusButtons.forEach((button) => button.classList.remove("is-active"));
    filterStrip.hidden = true;
    filterStrip.classList.remove("is-visible");
    tabButtons.forEach((button) => button.classList.remove("is-active"));
    renderMarkers();
    moveMapToItems(getActiveItems());
    renderDetail(null);
    return;
  }

  if (category === "markets") {
    filterStrip.hidden = false;
    filterStrip.classList.add("is-visible");
  } else {
    filterStrip.hidden = true;
    filterStrip.classList.remove("is-visible");
  }
  activeCategory = category;
  activeMarketStatus = "all";
  marketStatusButtons.forEach((button) => button.classList.remove("is-active"));
  activeItemId = null;

  tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.category === category);
  });

  renderMarkers();
  moveMapToItems(getActiveItems());
  renderDetail(null);
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchCategory(button.dataset.category));
});

searchInput.addEventListener("input", () => {
  renderMarkers();
  scheduleFitSearchResults();
  const items = getActiveItems();
  const selectedItem = items.find((item) => item.id === activeItemId);
  renderDetail(selectedItem || null);
});

marketStatusButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (activeCategory !== "markets") return;

    const nextStatus = button.dataset.marketStatus;
    activeMarketStatus = activeMarketStatus === nextStatus ? "all" : nextStatus;
    marketStatusButtons.forEach((statusButton) => {
      statusButton.classList.toggle(
        "is-active",
        statusButton.dataset.marketStatus === activeMarketStatus
      );
    });
    activeItemId = null;
    renderMarkers();
    moveMapToItems(getActiveItems());
    renderDetail(null);
  });
});

function didClickOutsideDetail(event) {
  if (!activeItemId) return;

  const clickedInsideDetail = detailPanel.contains(event.target);
  const clickedMarker = event.target.closest(".place-marker");
  const clickedHeader = event.target.closest(".floating-header");
  const clickedFilter = event.target.closest(".filter-strip");

  if (clickedInsideDetail || clickedMarker || clickedHeader || clickedFilter) return;

  closeDetail();
}

document.addEventListener("pointerdown", didClickOutsideDetail, true);
document.addEventListener("click", didClickOutsideDetail);

function loadAmapScript() {
  return new Promise((resolve, reject) => {
    if (!appConfig.amapKey) {
      reject(new Error("Missing AMap key"));
      return;
    }

    if (window.AMap) {
      resolve();
      return;
    }

    if (appConfig.amapSecurityJsCode) {
      window._AMapSecurityConfig = {
        securityJsCode: appConfig.amapSecurityJsCode,
      };
    }

    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(appConfig.amapKey)}`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load AMap"));
    document.head.appendChild(script);
  });
}

async function initMap() {
  renderMarkers();
  renderDetail(null);

  try {
    await loadAmapScript();
    amap = new window.AMap.Map("amap-map", {
      center: SHANGHAI_CENTER,
      features: ["bg", "road", "building", "point"],
      mapStyle: "amap://styles/macaron",
      resizeEnable: true,
      viewMode: "2D",
      zoom: DEFAULT_ZOOM,
    });
    currentCenter = SHANGHAI_CENTER;
    currentZoom = DEFAULT_ZOOM;

    document.querySelector(".map-stage").classList.add("has-real-map");
    amap.on("zoomstart", () => {
      isMapZooming = true;
      window.clearTimeout(renderTimer);
    });
    amap.on("zoomchange", () => {
      currentZoom = amap.getZoom();
    });
    amap.on("zoomend", () => {
      currentZoom = amap.getZoom();
      syncMapState();
      scheduleRenderMarkersAfterZoom();
    });
    amap.on("moveend", scheduleRenderMarkers);
    amap.on("resize", scheduleRenderMarkers);
    amap.on("click", closeDetailFromMap);
    renderMarkers();
  } catch {
    document.querySelector(".map-stage").classList.remove("has-real-map");
  }
}

initMap();
