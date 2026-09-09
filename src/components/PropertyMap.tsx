"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { supabase } from "@/lib/supabase";
import {
  PROPERTY_STATUS_PIN_COLORS,
  normalizePropertyStatus,
} from "@/lib/property-status";
import { purgeExpiredProperties } from "@/lib/purge-expired-properties";
import type { PropertyStatus } from "@/types/database";

const LONDON_CENTER: [number, number] = [-0.1276, 51.5072];
const DEFAULT_ZOOM = 13;

const STATUS_PIN_COLORS = PROPERTY_STATUS_PIN_COLORS;

export type PropertyMarkerData = {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  status?: PropertyStatus | null;
  postcode?: string | null;
  size_sqft?: number | null;
  building?: string | null;
};

export type PropertyFilter = {
  query: string;
  floorMin?: number;
  floorMax?: number;
  buildingMin?: number;
  buildingMax?: number;
};

export type PropertyMapHandle = {
  addMarker: (property: PropertyMarkerData) => void;
  updateMarker: (property: PropertyMarkerData) => void;
  removeMarker: (propertyId: string) => void;
  flyTo: (coords: { latitude: number; longitude: number }) => void;
  applyFilter: (filter: PropertyFilter) => void;
};

type PropertyMapProps = {
  onPropertySelect?: (propertyId: string) => void;
  onMapBackgroundClick?: () => void;
};

type PropertyMarkerRow = {
  id: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  status: PropertyStatus | null;
  postcode: string | null;
  size_sqft: number | null;
  building: string | null;
};

/** Extracts the first number in a free-text building-size string, e.g. "25,000 sq ft" -> 25000. */
function parseLeadingNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (!match) return null;
  return Number(match[0]);
}

function matchesFilter(
  property: PropertyMarkerRow,
  filter: PropertyFilter,
): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query) {
    const haystack = [property.address, property.postcode, property.building]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (filter.floorMin != null || filter.floorMax != null) {
    if (property.size_sqft == null) return false;
    if (filter.floorMin != null && property.size_sqft < filter.floorMin) {
      return false;
    }
    if (filter.floorMax != null && property.size_sqft > filter.floorMax) {
      return false;
    }
  }

  if (filter.buildingMin != null || filter.buildingMax != null) {
    const buildingSize = parseLeadingNumber(property.building);
    if (buildingSize == null) return false;
    if (filter.buildingMin != null && buildingSize < filter.buildingMin) {
      return false;
    }
    if (filter.buildingMax != null && buildingSize > filter.buildingMax) {
      return false;
    }
  }

  return true;
}

/** Transit / transport layers should stay visible even if they look POI-like. */
function isTransitOrTransportLayer(
  layerId: string,
  sourceLayer?: string,
): boolean {
  const haystack = `${layerId} ${sourceLayer ?? ""}`.toLowerCase();
  return /transit|transport|railway|rail\b|station|subway|metro|tram|bus|ferry|airport|aerodrome|aeroway/.test(
    haystack,
  );
}

/**
 * Shops, restaurants, and general points of interest.
 * Street-name / road-label layers are intentionally not matched.
 */
function isPoiLayer(layerId: string, sourceLayer?: string): boolean {
  const id = layerId.toLowerCase();
  const source = (sourceLayer ?? "").toLowerCase();

  if (source === "poi" || source.startsWith("poi")) return true;
  if (
    /(^|[-_ ])poi([-_ .]|$)/.test(id) ||
    id.includes("poi-") ||
    id.startsWith("poi")
  ) {
    return true;
  }
  if (
    /shop|restaurant|fast[_-]?food|cafe|amenity|attraction|tourism|leisure/.test(
      id,
    )
  ) {
    return true;
  }
  return false;
}

function hidePoiLayers(map: maplibregl.Map) {
  const layers = map.getStyle().layers ?? [];
  const layerIds = layers.map((layer) => layer.id);
  console.log("Map style layer IDs:", layerIds);

  for (const layer of layers) {
    const sourceLayer =
      "source-layer" in layer
        ? (layer["source-layer"] as string | undefined)
        : undefined;

    if (isTransitOrTransportLayer(layer.id, sourceLayer)) {
      continue;
    }

    if (isPoiLayer(layer.id, sourceLayer)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

function pinColorForStatus(status?: PropertyStatus | null): string {
  return STATUS_PIN_COLORS[normalizePropertyStatus(status)];
}

/** Teardrop pin SVG — tip is at the bottom center of the viewBox. */
function createPinSvg(fill: string): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 40" width="28" height="40" aria-hidden="true" focusable="false">
      <path
        d="M14 0C6.268 0 0 6.268 0 14c0 9.625 12.042 24.292 12.554 24.906a1.87 1.87 0 0 0 2.892 0C16.958 38.292 28 23.625 28 14 28 6.268 21.732 0 14 0z"
        fill="${fill}"
        stroke="#ffffff"
        stroke-width="1.75"
      />
      <circle cx="14" cy="14" r="5" fill="#ffffff" fill-opacity="0.9" />
    </svg>
  `.trim();
}

function createMarkerElement(
  property: PropertyMarkerData,
  onSelect: (propertyId: string) => void,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "property-map-marker";
  el.title = property.address;
  el.setAttribute("aria-label", `View ${property.address}`);
  el.dataset.status = normalizePropertyStatus(property.status);
  el.innerHTML = createPinSvg(pinColorForStatus(property.status));
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect(property.id);
  });
  return el;
}

function createPropertyMarker(
  map: maplibregl.Map,
  property: PropertyMarkerData,
  onSelect: (propertyId: string) => void,
): maplibregl.Marker {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[PropertyMap] setLngLat for marker:", {
      id: property.id,
      address: property.address,
      latitude: property.latitude,
      longitude: property.longitude,
      lngLatArg: [property.longitude, property.latitude],
    });
  }

  return new maplibregl.Marker({
    element: createMarkerElement(property, onSelect),
    anchor: "bottom",
  })
    .setLngLat([property.longitude, property.latitude])
    .addTo(map);
}

const PropertyMap = forwardRef<PropertyMapHandle, PropertyMapProps>(
  function PropertyMap({ onPropertySelect, onMapBackgroundClick }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const markersByIdRef = useRef(new Map<string, maplibregl.Marker>());
    const propertiesByIdRef = useRef(new Map<string, PropertyMarkerRow>());
    const lastFilterRef = useRef<PropertyFilter>({ query: "" });
    const onSelectRef = useRef(onPropertySelect);
    const onBackgroundClickRef = useRef(onMapBackgroundClick);

    useEffect(() => {
      onSelectRef.current = onPropertySelect;
    }, [onPropertySelect]);

    useEffect(() => {
      onBackgroundClickRef.current = onMapBackgroundClick;
    }, [onMapBackgroundClick]);

    function selectProperty(propertyId: string) {
      onSelectRef.current?.(propertyId);
    }

    useImperativeHandle(ref, () => {
      function storeProperty(property: PropertyMarkerData) {
        propertiesByIdRef.current.set(property.id, {
          id: property.id,
          address: property.address,
          latitude: property.latitude,
          longitude: property.longitude,
          status: property.status ?? null,
          postcode: property.postcode ?? null,
          size_sqft: property.size_sqft ?? null,
          building: property.building ?? null,
        });
      }

      function updateMarker(property: PropertyMarkerData) {
        storeProperty(property);

        const map = mapRef.current;
        if (!map) return;

        const existing = markersByIdRef.current.get(property.id);
        existing?.remove();
        markersByIdRef.current.delete(property.id);

        const stored = propertiesByIdRef.current.get(property.id)!;
        if (!matchesFilter(stored, lastFilterRef.current)) return;

        const marker = createPropertyMarker(map, property, selectProperty);
        markersByIdRef.current.set(property.id, marker);
      }

      function addMarker(property: PropertyMarkerData) {
        storeProperty(property);

        const map = mapRef.current;
        if (!map) return;

        if (markersByIdRef.current.has(property.id)) {
          updateMarker(property);
          return;
        }

        if (
          !matchesFilter(
            propertiesByIdRef.current.get(property.id)!,
            lastFilterRef.current,
          )
        ) {
          return;
        }

        const marker = createPropertyMarker(map, property, selectProperty);
        markersByIdRef.current.set(property.id, marker);
        map.flyTo({
          center: [property.longitude, property.latitude],
          zoom: Math.max(map.getZoom(), 13),
        });
      }

      function removeMarker(propertyId: string) {
        const marker = markersByIdRef.current.get(propertyId);
        marker?.remove();
        markersByIdRef.current.delete(propertyId);
        propertiesByIdRef.current.delete(propertyId);
      }

      function flyTo(coords: { latitude: number; longitude: number }) {
        const map = mapRef.current;
        if (!map) return;

        map.flyTo({
          center: [coords.longitude, coords.latitude],
          zoom: Math.max(map.getZoom(), DEFAULT_ZOOM),
        });
      }

      function applyFilter(filter: PropertyFilter) {
        lastFilterRef.current = filter;

        const map = mapRef.current;
        if (!map) return;

        for (const property of propertiesByIdRef.current.values()) {
          if (property.latitude == null || property.longitude == null) continue;

          const shouldShow = matchesFilter(property, filter);
          const hasMarker = markersByIdRef.current.has(property.id);

          if (shouldShow && !hasMarker) {
            const marker = createPropertyMarker(
              map,
              {
                id: property.id,
                address: property.address,
                latitude: property.latitude,
                longitude: property.longitude,
                status: property.status,
              },
              selectProperty,
            );
            markersByIdRef.current.set(property.id, marker);
          } else if (!shouldShow && hasMarker) {
            markersByIdRef.current.get(property.id)?.remove();
            markersByIdRef.current.delete(property.id);
          }
        }
      }

      return { addMarker, updateMarker, removeMarker, flyTo, applyFilter };
    });

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
      if (!maptilerKey) {
        console.error(
          "Missing NEXT_PUBLIC_MAPTILER_KEY. Add it to .env.local to load the map.",
        );
        return;
      }

      const signal = { cancelled: false };
      const markersById = markersByIdRef.current;
      const propertiesById = propertiesByIdRef.current;

      const map = new maplibregl.Map({
        container,
        style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`,
        center: LONDON_CENTER,
        zoom: DEFAULT_ZOOM,
      });
      mapRef.current = map;

      map.addControl(
        new maplibregl.NavigationControl({ showCompass: true }),
        "bottom-right",
      );

      map.on("click", () => {
        onBackgroundClickRef.current?.();
      });

      map.on("load", () => {
        if (signal.cancelled) return;
        hidePoiLayers(map);

        void (async () => {
          await purgeExpiredProperties();
          if (signal.cancelled) return;

          const { data, error } = await supabase
            .from("properties")
            .select(
              "id, address, latitude, longitude, status, postcode, size_sqft, building",
            );

          if (signal.cancelled) return;

          if (error) {
            console.error("Failed to fetch properties from Supabase:", error);
            return;
          }

          const properties = (data ?? []) as PropertyMarkerRow[];

          for (const property of properties) {
            if (property.latitude == null || property.longitude == null) continue;
            if (markersById.has(property.id)) continue;

            propertiesById.set(property.id, property);
            if (!matchesFilter(property, lastFilterRef.current)) continue;

            const marker = createPropertyMarker(
              map,
              {
                id: property.id,
                address: property.address,
                latitude: property.latitude,
                longitude: property.longitude,
                status: property.status,
              },
              selectProperty,
            );
            markersById.set(property.id, marker);
          }
        })();
      });

      return () => {
        signal.cancelled = true;
        for (const marker of markersById.values()) {
          marker.remove();
        }
        markersById.clear();
        propertiesById.clear();
        mapRef.current = null;
        map.remove();
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        role="region"
        aria-label="Property map"
      />
    );
  },
);

export default PropertyMap;
