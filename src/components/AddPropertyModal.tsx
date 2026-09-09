"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { createPortal } from "react-dom";

import {
  buildGeocodeQuery,
  describeLocationType,
  geocodeAddress,
  isLowConfidenceMatch,
  LONDON_ONLY_MESSAGE,
  type GeocodeResult,
} from "@/lib/geocode";
import {
  defaultAutoDeleteDateInput,
  defaultAutoDeleteHint,
  resolveAutoDeleteAt,
  toDateInputValue,
} from "@/lib/auto-delete";
import {
  findSimilarProperty,
  type SimilarProperty,
} from "@/lib/property-duplicates";
import {
  PROPERTY_STATUSES,
  propertyStatusLabel,
  normalizePropertyStatus,
} from "@/lib/property-status";
import GeocodePreviewMap from "@/components/GeocodePreviewMap";
import { supabase } from "@/lib/supabase";
import {
  uploadBrochure,
  uploadPropertyImage,
  removePropertyFiles,
  deletePropertyWithFiles,
} from "@/lib/property-uploads";
import type {
  Property,
  PropertyFile,
  PropertyStatus,
} from "@/types/database";

const ADDRESS_NOT_FOUND_MESSAGE =
  "Address not found in London — try adding more detail like postcode or building name.";

const STATUSES = PROPERTY_STATUSES;

export type CreatedPropertyMarker = {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  status: PropertyStatus;
  postcode?: string | null;
  size_sqft?: number | null;
  building?: string | null;
};

type AddPropertyModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (property: CreatedPropertyMarker) => void;
  onUpdated?: (property: CreatedPropertyMarker) => void;
  /** Open an existing property's detail panel (duplicate warning). */
  onViewExisting?: (propertyId: string) => void;
  propertyToEdit?: Property | null;
  existingFiles?: PropertyFile[];
};

type FormState = {
  address: string;
  postcode: string;
  size_sqft: string;
  availability_period: string;
  status: PropertyStatus;
  company: string;
  building: string;
  available_floors: string;
  agent_name: string;
  agent_phone: string;
  agent_email: string;
  notes: string;
  auto_delete_enabled: boolean;
  auto_delete_date: string;
};

type PendingUploadRetry = {
  propertyId: string;
  marker: CreatedPropertyMarker;
  brochures: File[];
  images: File[];
  failedFileName: string;
  /** When true, the property row was just inserted and can still be rolled back. */
  canRollback: boolean;
};

const INITIAL_FORM: FormState = {
  address: "",
  postcode: "",
  size_sqft: "",
  availability_period: "",
  status: PROPERTY_STATUSES[0],
  company: "",
  building: "",
  available_floors: "",
  agent_name: "",
  agent_phone: "",
  agent_email: "",
  notes: "",
  auto_delete_enabled: true,
  auto_delete_date: "",
};

function createInitialForm(): FormState {
  return {
    ...INITIAL_FORM,
    auto_delete_date: defaultAutoDeleteDateInput(),
  };
}

function propertyToFormState(property: Property): FormState {
  const hasAutoDelete = property.auto_delete_at != null;
  return {
    address: property.address,
    postcode: property.postcode ?? "",
    size_sqft: property.size_sqft != null ? String(property.size_sqft) : "",
    availability_period: property.availability_period ?? "",
    status: normalizePropertyStatus(property.status),
    company: property.company ?? "",
    building: property.building ?? "",
    available_floors: property.available_floors ?? "",
    agent_name: property.agent_name ?? "",
    agent_phone: property.agent_phone ?? "",
    agent_email: property.agent_email ?? "",
    notes: property.notes ?? "",
    auto_delete_enabled: hasAutoDelete,
    auto_delete_date: hasAutoDelete
      ? toDateInputValue(property.auto_delete_at)
      : defaultAutoDeleteDateInput(),
  };
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusLabel(status: PropertyStatus): string {
  return propertyStatusLabel(status);
}

function uploadFailureMessage(fileName: string): string {
  return `Failed to upload ${fileName} — please try again`;
}

function isGeocodeNotFoundError(message: string): boolean {
  return (
    message === ADDRESS_NOT_FOUND_MESSAGE ||
    message === LONDON_ONLY_MESSAGE ||
    /no location found|no usable coordinates|address not found|must be in london/i.test(
      message,
    )
  );
}

export default function AddPropertyModal({
  open,
  onClose,
  onCreated,
  onUpdated,
  onViewExisting,
  propertyToEdit = null,
  existingFiles = [],
}: AddPropertyModalProps) {
  const isEditing = propertyToEdit != null;
  const titleId = useId();
  const [form, setForm] = useState<FormState>(() =>
    propertyToEdit ? propertyToFormState(propertyToEdit) : createInitialForm(),
  );
  const [brochures, setBrochures] = useState<File[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [keptFiles, setKeptFiles] = useState<PropertyFile[]>(existingFiles);
  const [removedFiles, setRemovedFiles] = useState<PropertyFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<SimilarProperty | null>(null);
  const duplicateIgnoredRef = useRef(false);
  const [lowConfidenceMatch, setLowConfidenceMatch] =
    useState<GeocodeResult | null>(null);
  const lowConfidenceIgnoredRef = useRef(false);
  const [uploadRetry, setUploadRetry] = useState<PendingUploadRetry | null>(
    null,
  );
  const [brochureDropActive, setBrochureDropActive] = useState(false);
  const [imageDropActive, setImageDropActive] = useState(false);
  const [mediaModal, setMediaModal] = useState<"brochure" | "image" | null>(
    null,
  );
  const ignoreCloseUntilRef = useRef(0);

  function markFilePickerOpened() {
    // Native file dialog Cancel often fires Escape / a ghost click on the backdrop.
    ignoreCloseUntilRef.current = Date.now() + 800;
  }

  function closeMediaModal() {
    setMediaModal(null);
    setBrochureDropActive(false);
    setImageDropActive(false);
  }

  function requestClose() {
    if (Date.now() < ignoreCloseUntilRef.current) return;
    if (mediaModal != null) {
      closeMediaModal();
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || submitting) return;
      if (Date.now() < ignoreCloseUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (mediaModal != null) {
        event.preventDefault();
        closeMediaModal();
        return;
      }
      onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, submitting, mediaModal]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "address" || key === "postcode") {
      setAddressError(null);
      setDuplicate(null);
      duplicateIgnoredRef.current = false;
      setLowConfidenceMatch(null);
      lowConfidenceIgnoredRef.current = false;
    }
  }

  function removeExistingFile(fileId: string) {
    const target = keptFiles.find((file) => file.id === fileId);
    if (!target) return;
    setKeptFiles((current) => current.filter((file) => file.id !== fileId));
    setRemovedFiles((removed) =>
      removed.some((file) => file.id === fileId) ? removed : [...removed, target],
    );
  }

  function addBrochureFiles(fileList: FileList | File[]) {
    const selected = Array.from(fileList).filter(
      (file) =>
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf"),
    );
    if (selected.length === 0) return;
    setBrochures((current) => [...current, ...selected]);
    setUploadRetry(null);
  }

  function addImageFiles(fileList: FileList | File[]) {
    const selected = Array.from(fileList).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (selected.length === 0) return;
    setImages((current) => [...current, ...selected]);
    setUploadRetry(null);
  }

  function onDragOver(
    event: DragEvent<HTMLElement>,
    setActive: (active: boolean) => void,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setActive(true);
  }

  function onDragLeave(
    event: DragEvent<HTMLElement>,
    setActive: (active: boolean) => void,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setActive(false);
  }

  const keptBrochures = keptFiles.filter((file) => file.file_type === "brochure");
  const keptImages = keptFiles.filter((file) => file.file_type === "image");

  async function attachFiles(
    propertyId: string,
    brochureFiles: File[],
    imageFiles: File[],
  ): Promise<{ remainingBrochures: File[]; remainingImages: File[] }> {
    const remainingBrochures = [...brochureFiles];
    const remainingImages = [...imageFiles];

    while (remainingBrochures.length > 0) {
      const brochureFile = remainingBrochures[0];
      if (brochureFile.type !== "application/pdf") {
        throw new Error(`Brochure “${brochureFile.name}” must be a PDF file.`);
      }

      try {
        const brochureUrl = await uploadBrochure(
          propertyId,
          brochureFile,
          brochureFiles.length - remainingBrochures.length,
        );
        const { error: brochureError } = await supabase
          .from("property_files")
          .insert({
            property_id: propertyId,
            file_url: brochureUrl,
            file_type: "brochure",
          });

        if (brochureError) {
          throw new Error(uploadFailureMessage(brochureFile.name));
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("Failed to upload ")
        ) {
          throw Object.assign(err, {
            remainingBrochures,
            remainingImages,
            failedFileName: brochureFile.name,
          });
        }
        throw Object.assign(new Error(uploadFailureMessage(brochureFile.name)), {
          remainingBrochures,
          remainingImages,
          failedFileName: brochureFile.name,
        });
      }

      remainingBrochures.shift();
    }

    while (remainingImages.length > 0) {
      const imageFile = remainingImages[0];
      if (!imageFile.type.startsWith("image/")) {
        throw new Error(`“${imageFile.name}” is not an image file.`);
      }

      try {
        const imageUrl = await uploadPropertyImage(
          propertyId,
          imageFile,
          imageFiles.length - remainingImages.length,
        );
        const { error: imageError } = await supabase
          .from("property_files")
          .insert({
            property_id: propertyId,
            file_url: imageUrl,
            file_type: "image",
          });

        if (imageError) {
          throw new Error(uploadFailureMessage(imageFile.name));
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("Failed to upload ")
        ) {
          throw Object.assign(err, {
            remainingBrochures,
            remainingImages,
            failedFileName: imageFile.name,
          });
        }
        throw Object.assign(new Error(uploadFailureMessage(imageFile.name)), {
          remainingBrochures,
          remainingImages,
          failedFileName: imageFile.name,
        });
      }

      remainingImages.shift();
    }

    return { remainingBrochures, remainingImages };
  }

  function finishSave(marker: CreatedPropertyMarker) {
    if (isEditing) {
      onUpdated?.(marker);
    } else {
      onCreated(marker);
    }
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    console.debug("[AddPropertyModal] handleSubmit called");

    event.preventDefault();

    // Synchronous guard — React state alone cannot block double-submit races.
    if (submittingRef.current) return;

    setError(null);
    setAddressError(null);
    setUploadRetry(null);

    const address = form.address.trim();
    if (!address) {
      setAddressError("Address is required.");
      return;
    }

    const postcode = form.postcode.trim();
    const query = buildGeocodeQuery(address, postcode);

    submittingRef.current = true;
    setSubmitting(true);

    let createdPropertyId: string | null = null;

    try {
      if (!isEditing && !duplicateIgnoredRef.current) {
        const similar = await findSimilarProperty({ address, postcode });
        if (similar) {
          setDuplicate(similar);
          return;
        }
      }

      let geocoded;
      try {
        geocoded = await geocodeAddress(query);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : ADDRESS_NOT_FOUND_MESSAGE;
        if (isGeocodeNotFoundError(message)) {
          setAddressError(
            message === LONDON_ONLY_MESSAGE
              ? LONDON_ONLY_MESSAGE
              : ADDRESS_NOT_FOUND_MESSAGE,
          );
          return;
        }
        setError(message);
        return;
      }

      if (process.env.NODE_ENV !== "production") {
        console.debug("[AddPropertyModal] geocoded result:", {
          query,
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
          locationType: geocoded.locationType,
          placeName: geocoded.placeName,
        });
      }

      if (
        !lowConfidenceIgnoredRef.current &&
        isLowConfidenceMatch(geocoded.locationType)
      ) {
        setLowConfidenceMatch(geocoded);
        return;
      }

      let autoDeleteAt: string | null;
      try {
        autoDeleteAt = resolveAutoDeleteAt({
          enabled: form.auto_delete_enabled,
          dateInput: form.auto_delete_date,
          timeInput: "",
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Auto-delete date/time must be valid.",
        );
        return;
      }

      const payload = {
        address,
        postcode: postcode || null,
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
        size_sqft: parseOptionalNumber(form.size_sqft),
        availability_period: form.availability_period.trim() || null,
        status: normalizePropertyStatus(form.status),
        company: form.company.trim() || null,
        building: form.building.trim() || null,
        available_floors: form.available_floors.trim() || null,
        // No longer editable in the UI — preserve whatever an existing
        // record already has instead of wiping it out on every edit.
        floor: propertyToEdit?.floor ?? null,
        agent_name: form.agent_name.trim() || null,
        agent_phone: form.agent_phone.trim() || null,
        agent_email: form.agent_email.trim() || null,
        notes: form.notes.trim() || null,
        auto_delete_at: autoDeleteAt,
      };

      if (process.env.NODE_ENV !== "production") {
        console.debug("[AddPropertyModal] payload being saved to Supabase:", {
          latitude: payload.latitude,
          longitude: payload.longitude,
        });
      }

      const mutation = isEditing
        ? supabase
            .from("properties")
            .update(payload)
            .eq("id", propertyToEdit.id)
            .select(
              "id, address, latitude, longitude, status, postcode, size_sqft, building",
            )
            .single()
        : supabase
            .from("properties")
            .insert(payload)
            .select(
              "id, address, latitude, longitude, status, postcode, size_sqft, building",
            )
            .single();

      const { data: property, error: saveError } = await mutation;

      if (saveError || !property) {
        throw new Error(
          saveError?.message ?? "Failed to save the property record.",
        );
      }

      if (!isEditing) {
        createdPropertyId = property.id;
      }

      if (isEditing && removedFiles.length > 0) {
        await removePropertyFiles(removedFiles);
      }

      if (property.latitude == null || property.longitude == null) {
        throw new Error("Property saved without coordinates.");
      }

      if (process.env.NODE_ENV !== "production") {
        console.debug("[AddPropertyModal] coordinates read back from Supabase:", {
          latitude: property.latitude,
          longitude: property.longitude,
        });
      }

      const markerPayload: CreatedPropertyMarker = {
        id: property.id,
        address: property.address,
        latitude: property.latitude,
        longitude: property.longitude,
        status: (property.status ?? form.status) as PropertyStatus,
        postcode: property.postcode,
        size_sqft: property.size_sqft,
        building: property.building,
      };

      if (process.env.NODE_ENV !== "production") {
        console.debug(
          "[AddPropertyModal] marker payload handed to the map (setLngLat order is [longitude, latitude]):",
          markerPayload,
        );
      }

      try {
        await attachFiles(property.id, brochures, images);
      } catch (err) {
        const failedFileName =
          err && typeof err === "object" && "failedFileName" in err
            ? String((err as { failedFileName: string }).failedFileName)
            : "file";
        const remainingBrochures =
          err && typeof err === "object" && "remainingBrochures" in err
            ? ((err as { remainingBrochures: File[] }).remainingBrochures ?? [])
            : brochures;
        const remainingImages =
          err && typeof err === "object" && "remainingImages" in err
            ? ((err as { remainingImages: File[] }).remainingImages ?? [])
            : images;

        const message = uploadFailureMessage(failedFileName);

        if (!isEditing && createdPropertyId) {
          // Roll back the new property so we never leave an incomplete record.
          try {
            await deletePropertyWithFiles(createdPropertyId);
          } catch (rollbackError) {
            console.error("Failed to roll back property after upload error", rollbackError);
            setUploadRetry({
              propertyId: createdPropertyId,
              marker: markerPayload,
              brochures: remainingBrochures,
              images: remainingImages,
              failedFileName,
              canRollback: false,
            });
            setBrochures(remainingBrochures);
            setImages(remainingImages);
            setError(
              `${message}. The property was saved but one or more files were not attached.`,
            );
            return;
          }

          setBrochures(remainingBrochures);
          setImages(remainingImages);
          setError(message);
          return;
        }

        // Edit flow: property fields are already saved — offer retry for remaining files.
        setUploadRetry({
          propertyId: property.id,
          marker: markerPayload,
          brochures: remainingBrochures,
          images: remainingImages,
          failedFileName,
          canRollback: false,
        });
        setBrochures(remainingBrochures);
        setImages(remainingImages);
        onUpdated?.(markerPayload);
        setError(
          `${message}. Your property details were saved, but one or more files were not attached.`,
        );
        return;
      }

      finishSave(markerPayload);
    } catch (err) {
      if (createdPropertyId) {
        try {
          await deletePropertyWithFiles(createdPropertyId);
        } catch (rollbackError) {
          console.error("Failed to roll back property after save error", rollbackError);
        }
      }
      const message =
        err instanceof Error ? err.message : "Something went wrong while saving.";
      setError(message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleRetryUploads() {
    if (!uploadRetry || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await attachFiles(
        uploadRetry.propertyId,
        uploadRetry.brochures,
        uploadRetry.images,
      );
      setBrochures([]);
      setImages([]);
      setUploadRetry(null);
      finishSave(uploadRetry.marker);
    } catch (err) {
      const failedFileName =
        err && typeof err === "object" && "failedFileName" in err
          ? String((err as { failedFileName: string }).failedFileName)
          : uploadRetry.failedFileName;
      const remainingBrochures =
        err && typeof err === "object" && "remainingBrochures" in err
          ? ((err as { remainingBrochures: File[] }).remainingBrochures ?? [])
          : uploadRetry.brochures;
      const remainingImages =
        err && typeof err === "object" && "remainingImages" in err
          ? ((err as { remainingImages: File[] }).remainingImages ?? [])
          : uploadRetry.images;

      setUploadRetry({
        ...uploadRetry,
        brochures: remainingBrochures,
        images: remainingImages,
        failedFileName,
      });
      setBrochures(remainingBrochures);
      setImages(remainingImages);
      setError(uploadFailureMessage(failedFileName));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleContinueDespiteDuplicate() {
    // Ref must flip synchronously so the re-submit sees the acknowledgment.
    duplicateIgnoredRef.current = true;
    setDuplicate(null);
    queueMicrotask(() => {
      const formEl = document.getElementById(
        "add-property-form",
      ) as HTMLFormElement | null;
      formEl?.requestSubmit();
    });
  }

  function handleContinueDespiteLowConfidence() {
    // Ref must flip synchronously so the re-submit sees the acknowledgment.
    lowConfidenceIgnoredRef.current = true;
    setLowConfidenceMatch(null);
    queueMicrotask(() => {
      const formEl = document.getElementById(
        "add-property-form",
      ) as HTMLFormElement | null;
      formEl?.requestSubmit();
    });
  }

  function handleViewExistingDuplicate() {
    if (!duplicate) return;
    const id = duplicate.id;
    onClose();
    onViewExisting?.(id);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog backdrop"
        className="absolute inset-0 cursor-default"
        disabled={submitting}
        onClick={() => {
          if (!submitting) requestClose();
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 my-auto flex max-h-[min(90dvh,880px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-zinc-900">
              {isEditing ? "Edit property" : "Add property"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {isEditing
                ? "Update details, re-geocode the address, and optionally add more files."
                : "Geocodes the address, uploads files, and drops a marker on the map."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <form
          id="add-property-form"
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {error ? (
              <div
                role="alert"
                className="space-y-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                <p>{error}</p>
                {uploadRetry ? (
                  <button
                    type="button"
                    onClick={() => void handleRetryUploads()}
                    disabled={submitting}
                    className="rounded-md bg-red-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-900 disabled:opacity-60"
                  >
                    {submitting
                      ? "Retrying…"
                      : `Retry failed upload (${uploadRetry.failedFileName})`}
                  </button>
                ) : null}
              </div>
            ) : null}

            {duplicate ? (
              <div
                role="status"
                className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950"
              >
                <p>
                  A similar property already exists: {duplicate.address}
                  {duplicate.postcode ? ` (${duplicate.postcode})` : ""} — do
                  you want to continue adding this as a new entry, or view the
                  existing one?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleContinueDespiteDuplicate}
                    disabled={submitting}
                    className="rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-950 disabled:opacity-60"
                  >
                    Continue anyway
                  </button>
                  <button
                    type="button"
                    onClick={handleViewExistingDuplicate}
                    disabled={submitting}
                    className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-60"
                  >
                    View existing
                  </button>
                  <button
                    type="button"
                    onClick={() => setDuplicate(null)}
                    disabled={submitting}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {lowConfidenceMatch ? (
              <div
                role="status"
                className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950"
              >
                <p>
                  This address matched “{lowConfidenceMatch.placeName}”, but
                  Google could only provide{" "}
                  {describeLocationType(lowConfidenceMatch.locationType)}.
                  Please confirm the pin location is correct, or adjust the
                  address/postcode above for a better match, before saving.
                </p>
                <GeocodePreviewMap
                  latitude={lowConfidenceMatch.latitude}
                  longitude={lowConfidenceMatch.longitude}
                  label={lowConfidenceMatch.placeName}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleContinueDespiteLowConfidence}
                    disabled={submitting}
                    className="rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-950 disabled:opacity-60"
                  >
                    Confirm pin location
                  </button>
                  <button
                    type="button"
                    onClick={() => setLowConfidenceMatch(null)}
                    disabled={submitting}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                  >
                    Let me adjust it
                  </button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Address
                </span>
                <input
                  required
                  value={form.address}
                  onChange={(e) => updateField("address", e.target.value)}
                  aria-invalid={addressError != null}
                  className={[
                    "w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-zinc-500",
                    addressError
                      ? "border-red-400 focus:border-red-500"
                      : "border-zinc-300",
                  ].join(" ")}
                  placeholder="123 Example Street, London"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Postcode
                </span>
                <input
                  value={form.postcode}
                  onChange={(e) => updateField("postcode", e.target.value)}
                  aria-invalid={addressError != null}
                  className={[
                    "w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-zinc-500",
                    addressError
                      ? "border-red-400 focus:border-red-500"
                      : "border-zinc-300",
                  ].join(" ")}
                  placeholder="EC2A 4BX (London)"
                />
              </label>

              {addressError ? (
                <p
                  role="alert"
                  className="sm:col-span-2 -mt-2 text-sm text-red-700"
                >
                  {addressError}
                </p>
              ) : null}

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Status
                </span>
                <select
                  value={form.status}
                  onChange={(e) =>
                    updateField("status", e.target.value as PropertyStatus)
                  }
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                >
                  {!STATUSES.includes(form.status) ? (
                    <option value={form.status}>
                      {statusLabel(form.status)}
                    </option>
                  ) : null}
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Availability date
                </span>
                <input
                  value={form.availability_period}
                  onChange={(e) =>
                    updateField("availability_period", e.target.value)
                  }
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  placeholder="H2 2027"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Building size
                </span>
                <input
                  value={form.building}
                  onChange={(e) => updateField("building", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Available floors
                </span>
                <input
                  value={form.available_floors}
                  onChange={(e) =>
                    updateField("available_floors", e.target.value)
                  }
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  placeholder="e.g. 2nd, 3rd"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Approx Floor Size
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.size_sqft}
                  onChange={(e) => updateField("size_sqft", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Agent name
                </span>
                <input
                  value={form.agent_name}
                  onChange={(e) => updateField("agent_name", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Agent Company
                </span>
                <input
                  value={form.company}
                  onChange={(e) => updateField("company", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Agent Email
                </span>
                <input
                  type="email"
                  value={form.agent_email}
                  onChange={(e) => updateField("agent_email", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Agent number
                </span>
                <input
                  value={form.agent_phone}
                  onChange={(e) => updateField("agent_phone", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <label className="block sm:col-span-2">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Notes
                </span>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(e) => updateField("notes", e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>

              <div className="sm:col-span-2 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3">
                <div className="flex items-start gap-3">
                  <input
                    id="auto-delete-enabled"
                    type="checkbox"
                    checked={form.auto_delete_enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setForm((current) => ({
                        ...current,
                        auto_delete_enabled: enabled,
                        auto_delete_date:
                          enabled && !current.auto_delete_date
                            ? defaultAutoDeleteDateInput()
                            : current.auto_delete_date,
                      }));
                    }}
                    className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
                  />
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="auto-delete-enabled"
                      className="block text-sm font-medium text-zinc-700"
                    >
                      Auto-delete this property
                    </label>
                    <p className="mt-1 text-xs text-zinc-500">
                      {defaultAutoDeleteHint()}
                    </p>
                  </div>
                </div>

                {form.auto_delete_enabled ? (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-600">
                      Delete date
                    </span>
                    <input
                      type="date"
                      required={form.auto_delete_enabled}
                      value={form.auto_delete_date}
                      onChange={(e) =>
                        updateField("auto_delete_date", e.target.value)
                      }
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500"
                    />
                  </label>
                ) : (
                  <p className="text-sm text-zinc-600">
                    This property will be kept (no automatic deletion).
                  </p>
                )}
              </div>

              {isEditing ? (
                <div className="space-y-3 sm:col-span-2">
                  <div>
                    <p className="mb-2 text-sm font-medium text-zinc-700">
                      Existing brochures
                    </p>
                    {keptBrochures.length === 0 ? (
                      <p className="text-sm text-zinc-500">No brochures attached.</p>
                    ) : (
                      <ul className="space-y-2">
                        {keptBrochures.map((file, index) => (
                          <li
                            key={file.id}
                            className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                          >
                            <a
                              href={file.file_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-sm text-zinc-800 underline decoration-zinc-300 underline-offset-2"
                            >
                              Brochure {index + 1}
                            </a>
                            <button
                              type="button"
                              onClick={() => removeExistingFile(file.id)}
                              className="rounded-md px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                              aria-label="Remove brochure"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <p className="mb-2 text-sm font-medium text-zinc-700">
                      Existing images
                    </p>
                    {keptImages.length === 0 ? (
                      <p className="text-sm text-zinc-500">No images attached.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {keptImages.map((file) => (
                          <div
                            key={file.id}
                            className="relative aspect-square overflow-hidden rounded-md border border-zinc-200 bg-zinc-100"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={file.file_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                            <button
                              type="button"
                              onClick={() => removeExistingFile(file.id)}
                              className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-xs text-white hover:bg-black"
                              aria-label="Remove image"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="sm:col-span-2 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setMediaModal("brochure")}
                    disabled={submitting}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {isEditing ? "Add brochures" : "Add brochures (PDF)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMediaModal("image")}
                    disabled={submitting}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {isEditing ? "Add images" : "Add images"}
                  </button>
                </div>

                {brochures.length > 0 ? (
                  <ul className="space-y-2">
                    <li className="text-xs text-zinc-500">
                      {brochures.length} brochure
                      {brochures.length === 1 ? "" : "s"} selected
                    </li>
                    {brochures.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                      >
                        <span className="truncate text-sm text-zinc-800">
                          {file.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setBrochures((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                          className="rounded-md px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                          aria-label={`Remove ${file.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {images.length > 0 ? (
                  <ul className="space-y-2">
                    <li className="text-xs text-zinc-500">
                      {images.length} image{images.length === 1 ? "" : "s"}{" "}
                      selected
                    </li>
                    {images.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                      >
                        <span className="truncate text-sm text-zinc-800">
                          {file.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setImages((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                          className="rounded-md px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                          aria-label={`Remove ${file.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-zinc-200 bg-zinc-50 px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || duplicate != null || lowConfidenceMatch != null}
              className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Saving…" : isEditing ? "Save changes" : "Save property"}
            </button>
          </div>
        </form>
      </div>

      {mediaModal != null
        ? createPortal(
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
              <button
                type="button"
                aria-label="Close media dialog backdrop"
                className="absolute inset-0 cursor-default"
                onClick={closeMediaModal}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label={
                  mediaModal === "brochure" ? "Add brochures" : "Add images"
                }
                className="relative z-10 w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-zinc-900">
                      {mediaModal === "brochure"
                        ? "Add brochures (PDF)"
                        : "Add images"}
                    </h3>
                    <p className="mt-1 text-xs text-zinc-500">
                      {mediaModal === "brochure"
                        ? "Drag and drop PDFs here, or choose files. Multiple allowed."
                        : "Drag and drop images here, or choose files (JPEG, PNG, WebP, or GIF). Multiple allowed."}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeMediaModal}
                    className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                  >
                    Close
                  </button>
                </div>

                {mediaModal === "brochure" ? (
                  <label
                    onDragEnter={(e) => onDragOver(e, setBrochureDropActive)}
                    onDragOver={(e) => onDragOver(e, setBrochureDropActive)}
                    onDragLeave={(e) => onDragLeave(e, setBrochureDropActive)}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setBrochureDropActive(false);
                      addBrochureFiles(e.dataTransfer.files);
                    }}
                    className={[
                      "flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-10 text-center transition-colors",
                      brochureDropActive
                        ? "border-zinc-500 bg-zinc-100"
                        : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 hover:bg-zinc-100",
                    ].join(" ")}
                  >
                    <span className="text-sm font-medium text-zinc-800">
                      Drop PDF brochures here
                    </span>
                    <span className="mt-1 text-xs text-zinc-500">
                      or click to browse
                    </span>
                    <input
                      type="file"
                      name="brochures"
                      accept="application/pdf,.pdf"
                      multiple
                      onClick={markFilePickerOpened}
                      onChange={(e) => {
                        addBrochureFiles(e.target.files ?? []);
                        e.target.value = "";
                      }}
                      className="sr-only"
                    />
                  </label>
                ) : (
                  <label
                    onDragEnter={(e) => onDragOver(e, setImageDropActive)}
                    onDragOver={(e) => onDragOver(e, setImageDropActive)}
                    onDragLeave={(e) => onDragLeave(e, setImageDropActive)}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setImageDropActive(false);
                      addImageFiles(e.dataTransfer.files);
                    }}
                    className={[
                      "flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-10 text-center transition-colors",
                      imageDropActive
                        ? "border-zinc-500 bg-zinc-100"
                        : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 hover:bg-zinc-100",
                    ].join(" ")}
                  >
                    <span className="text-sm font-medium text-zinc-800">
                      Drop images here
                    </span>
                    <span className="mt-1 text-xs text-zinc-500">
                      or click to browse
                    </span>
                    <input
                      type="file"
                      name="images"
                      accept="image/jpeg,image/png,image/webp,image/gif,image/*"
                      multiple
                      onClick={markFilePickerOpened}
                      onChange={(e) => {
                        addImageFiles(e.target.files ?? []);
                        e.target.value = "";
                      }}
                      className="sr-only"
                    />
                  </label>
                )}

                {mediaModal === "brochure" && brochures.length > 0 ? (
                  <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto">
                    {brochures.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                      >
                        <span className="truncate text-sm text-zinc-800">
                          {file.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setBrochures((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                          className="rounded-md px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                          aria-label={`Remove ${file.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {mediaModal === "image" && images.length > 0 ? (
                  <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto">
                    {images.map((file, index) => (
                      <li
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                      >
                        <span className="truncate text-sm text-zinc-800">
                          {file.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setImages((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                          className="rounded-md px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                          aria-label={`Remove ${file.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeMediaModal}
                    className="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={closeMediaModal}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
