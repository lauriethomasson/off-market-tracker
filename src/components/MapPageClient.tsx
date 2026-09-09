"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import AddPropertyModal, {
  type CreatedPropertyMarker,
} from "@/components/AddPropertyModal";
import PropertyDetailPanel from "@/components/PropertyDetailPanel";
import PropertyMap, {
  type PropertyMapHandle,
} from "@/components/PropertyMap";
import {
  PROPERTY_STATUSES,
  PROPERTY_STATUS_LABELS,
  PROPERTY_STATUS_PIN_COLORS,
} from "@/lib/property-status";
import { supabase } from "@/lib/supabase";
import type { Property, PropertyFile } from "@/types/database";

type SizeRangeDraft = {
  min: string;
  max: string;
};

type AppliedSizeRange = {
  min?: number;
  max?: number;
};

const EMPTY_SIZE_RANGE: SizeRangeDraft = { min: "", max: "" };

function parseSizeInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function MapPageClient() {
  const router = useRouter();
  const mapRef = useRef<PropertyMapHandle>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalKey, setModalKey] = useState(0);
  const [propertyToEdit, setPropertyToEdit] = useState<Property | null>(null);
  const [filesToEdit, setFilesToEdit] = useState<PropertyFile[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(
    null,
  );
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [floorDraft, setFloorDraft] = useState<SizeRangeDraft>(EMPTY_SIZE_RANGE);
  const [buildingDraft, setBuildingDraft] =
    useState<SizeRangeDraft>(EMPTY_SIZE_RANGE);
  const [appliedFloorRange, setAppliedFloorRange] =
    useState<AppliedSizeRange>({});
  const [appliedBuildingRange, setAppliedBuildingRange] =
    useState<AppliedSizeRange>({});

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, 200);
    return () => clearTimeout(timeout);
  }, [searchText]);

  useEffect(() => {
    mapRef.current?.applyFilter({
      query: debouncedSearchText,
      floorMin: appliedFloorRange.min,
      floorMax: appliedFloorRange.max,
      buildingMin: appliedBuildingRange.min,
      buildingMax: appliedBuildingRange.max,
    });
  }, [debouncedSearchText, appliedFloorRange, appliedBuildingRange]);

  const applyDropdownFilters = useCallback(() => {
    setAppliedFloorRange({
      min: parseSizeInput(floorDraft.min),
      max: parseSizeInput(floorDraft.max),
    });
    setAppliedBuildingRange({
      min: parseSizeInput(buildingDraft.min),
      max: parseSizeInput(buildingDraft.max),
    });
    setFiltersOpen(false);
  }, [floorDraft, buildingDraft]);

  const clearDropdownFilters = useCallback(() => {
    setFloorDraft(EMPTY_SIZE_RANGE);
    setBuildingDraft(EMPTY_SIZE_RANGE);
    setAppliedFloorRange({});
    setAppliedBuildingRange({});
  }, []);

  const openCreateModal = useCallback(() => {
    setPropertyToEdit(null);
    setFilesToEdit([]);
    setModalKey((key) => key + 1);
    setModalOpen(true);
  }, []);

  const openEditModal = useCallback(
    (property: Property, files: PropertyFile[]) => {
      setPropertyToEdit(property);
      setFilesToEdit(files);
      setModalKey((key) => key + 1);
      setModalOpen(true);
    },
    [],
  );

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setPropertyToEdit(null);
    setFilesToEdit([]);
  }, []);

  const handleCreated = useCallback((property: CreatedPropertyMarker) => {
    mapRef.current?.addMarker(property);
    setSelectedPropertyId(property.id);
  }, []);

  const handleUpdated = useCallback((property: CreatedPropertyMarker) => {
    mapRef.current?.updateMarker(property);
    setSelectedPropertyId(property.id);
    setDetailRefreshToken((token) => token + 1);
  }, []);

  const handleDeleted = useCallback((propertyId: string) => {
    mapRef.current?.removeMarker(propertyId);
    setSelectedPropertyId(null);
  }, []);

  const handlePropertySelect = useCallback((propertyId: string) => {
    setSelectedPropertyId(propertyId);
  }, []);

  const handleMapBackgroundClick = useCallback(() => {
    setSelectedPropertyId(null);
  }, []);

  const handleViewExisting = useCallback((propertyId: string) => {
    setSelectedPropertyId(propertyId);

    void (async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("latitude, longitude")
        .eq("id", propertyId)
        .single();

      if (error || !data || data.latitude == null || data.longitude == null) {
        return;
      }

      mapRef.current?.flyTo({
        latitude: data.latitude,
        longitude: data.longitude,
      });
    })();
  }, []);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }, [router]);

  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 p-4 sm:p-6">
        <div className="pointer-events-auto flex flex-col items-start gap-3">
          <div className="rounded-md bg-white/90 px-4 py-3 shadow-sm backdrop-blur">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Off-Market Tracker
            </p>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-zinc-900">
              London properties
            </h1>
          </div>

          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-zinc-800"
          >
            Add Property
          </button>

          <div className="relative z-20 w-48 rounded-md bg-white/90 px-3 py-2.5 shadow-sm backdrop-blur sm:w-52">
            <div className="flex items-center gap-1.5">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="h-4 w-4 flex-shrink-0 text-zinc-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
              >
                <circle cx="9" cy="9" r="6" />
                <path d="M17 17l-4-4" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Floor size, building size…"
                className="w-full min-w-0 text-xs text-zinc-900 outline-none placeholder:text-zinc-400"
              />
              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-label="Toggle filters"
                aria-expanded={filtersOpen}
                className={[
                  "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md",
                  filtersOpen
                    ? "bg-zinc-900 text-white"
                    : "bg-white text-zinc-700 hover:bg-zinc-100",
                ].join(" ")}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  className="h-3.5 w-3.5"
                  fill="currentColor"
                >
                  <path d="M2.5 3.5A1 1 0 0 1 3.5 2.5h13a1 1 0 0 1 .78 1.625L12 11.5v4.146a1 1 0 0 1-1.447.894l-2-1a1 1 0 0 1-.553-.894V11.5L2.72 4.125A1 1 0 0 1 2.5 3.5z" />
                </svg>
              </button>
            </div>

            {filtersOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1.5 w-56 rounded-md bg-white/90 p-3 shadow-sm backdrop-blur">
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                      Floor size (sq ft)
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        type="number"
                        value={floorDraft.min}
                        onChange={(e) =>
                          setFloorDraft((prev) => ({
                            ...prev,
                            min: e.target.value,
                          }))
                        }
                        placeholder="Min"
                        className="w-full min-w-0 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
                      />
                      <span className="text-xs text-zinc-400">–</span>
                      <input
                        type="number"
                        value={floorDraft.max}
                        onChange={(e) =>
                          setFloorDraft((prev) => ({
                            ...prev,
                            max: e.target.value,
                          }))
                        }
                        placeholder="Max"
                        className="w-full min-w-0 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
                      />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                      Building size (sq ft)
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        type="number"
                        value={buildingDraft.min}
                        onChange={(e) =>
                          setBuildingDraft((prev) => ({
                            ...prev,
                            min: e.target.value,
                          }))
                        }
                        placeholder="Min"
                        className="w-full min-w-0 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
                      />
                      <span className="text-xs text-zinc-400">–</span>
                      <input
                        type="number"
                        value={buildingDraft.max}
                        onChange={(e) =>
                          setBuildingDraft((prev) => ({
                            ...prev,
                            max: e.target.value,
                          }))
                        }
                        placeholder="Max"
                        className="w-full min-w-0 rounded-md border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={clearDropdownFilters}
                      className="text-xs font-medium text-zinc-500 hover:text-zinc-700"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={applyDropdownFilters}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-zinc-800"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="w-48 rounded-md bg-white/90 px-3 py-2.5 shadow-sm backdrop-blur sm:w-52">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Status
            </p>
            <ul className="mt-2 space-y-1.5">
              {PROPERTY_STATUSES.map((status) => (
                <li key={status} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{
                      backgroundColor: PROPERTY_STATUS_PIN_COLORS[status],
                    }}
                  />
                  <span className="text-xs leading-snug break-words text-zinc-700">
                    {PROPERTY_STATUS_LABELS[status]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/*
          Position with absolute right/top — not flex + margin.
          justify-between + mr-* looked like a no-op next to MapLibre's
          fixed top-right NavigationControl.
        */}
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          className="pointer-events-auto absolute top-4 right-4 z-10 rounded-md bg-white/90 px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm backdrop-blur hover:bg-white disabled:opacity-60 sm:top-6 sm:right-6"
        >
          {loggingOut ? "Logging out…" : "Log out"}
        </button>
      </header>

      <div className="absolute inset-0 overflow-hidden">
        <PropertyMap
          ref={mapRef}
          onPropertySelect={handlePropertySelect}
          onMapBackgroundClick={handleMapBackgroundClick}
        />
      </div>

      <PropertyDetailPanel
        propertyId={selectedPropertyId}
        onClose={() => setSelectedPropertyId(null)}
        onEdit={openEditModal}
        onDeleted={handleDeleted}
        refreshToken={detailRefreshToken}
      />

      <AddPropertyModal
        key={modalKey}
        open={modalOpen}
        onClose={closeModal}
        onCreated={handleCreated}
        onUpdated={handleUpdated}
        onViewExisting={handleViewExisting}
        propertyToEdit={propertyToEdit}
        existingFiles={filesToEdit}
      />
    </>
  );
}
