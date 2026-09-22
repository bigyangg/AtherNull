import React from "react";
import { cn } from "#/utils/utils";

/**
 * SPIKE-B STUB (see MANIFEST.md "Image carousel" row): the real
 * `ImageCarousel` renders through `ImagePreview` -> `ImageLightbox` /
 * `Thumbnail` / `RemoveButton`, none of which were vendored (no fixture in
 * this harness carries image attachments, and that chain is unrelated to
 * either of the 2 target reuse units). This keeps the same prop signature
 * `user-assistant-event-message.tsx` / `finish-event-message.tsx` /
 * `thought-event-message.tsx` call it with, so those real vendored files are
 * unmodified, but renders a plain `<img>` grid with no zoom/lightbox/remove.
 */
interface ImageCarouselProps {
  size: "small" | "large";
  images: string[];
  onRemove?: (index: number) => void;
}

export function ImageCarousel({
  size = "small",
  images,
  onRemove,
}: ImageCarouselProps) {
  if (images.length === 0) return null;
  return (
    <div data-testid="image-carousel" className="relative flex overflow-x-auto gap-2">
      {images.map((src, index) => (
        <div key={index} className="relative shrink-0 py-1">
          <img
            src={src}
            alt=""
            className={cn(
              "rounded-sm object-cover",
              size === "small" ? "h-16 w-16" : "h-32 w-32",
            )}
          />
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="absolute right-0.5 top-0.5 rounded-full bg-surface-deep/80 px-1 text-xs text-foreground"
            >
              x
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
