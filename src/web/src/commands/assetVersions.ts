import type { Asset, Operation, PreparedAsset, PreparedAssetRef, Snapshot } from '../model/types';
import { err, ok, type Result } from '../model/result';

const slugOf = (id: string) => id.replace(/^asset:/, '').split('~')[0];

/**
 * Turns an approved prepared asset into the document operations that make it usable.
 * Document assets are pinned: a new hash for an existing slug never overwrites the pinned
 * descriptor, it registers a separate version `asset:<slug>~<full-sha256>`.
 */
export function prepareDocumentAsset(snapshot: Snapshot, prepared: PreparedAsset | PreparedAssetRef): { operations: Operation[]; resolvedAssetId: string; versioned: boolean } {
  const asset: Asset = 'ref' in prepared ? prepared.ref.asset : prepared.asset;
  const assets = snapshot.document.assets;
  const same = assets.find((a) => a.id === asset.id);
  if (!same) return { operations: [{ op: 'registerAsset', asset }], resolvedAssetId: asset.id, versioned: false };
  if (same.sha256 === asset.sha256) return { operations: [], resolvedAssetId: same.id, versioned: false };
  const id = `asset:${slugOf(asset.id)}~${asset.sha256}`;
  if (assets.some((a) => a.id === id)) return { operations: [], resolvedAssetId: id, versioned: true };
  return { operations: [{ op: 'registerAsset', asset: { ...asset, id } }], resolvedAssetId: id, versioned: true };
}

/** A bare `asset:<slug>` resolves to the pinned document version; versions are addressed explicitly. */
export function resolveDocumentAsset(snapshot: Snapshot, idOrSlug: string): Result<Asset> {
  const id = idOrSlug.startsWith('asset:') ? idOrSlug : `asset:${idOrSlug}`;
  const exact = snapshot.document.assets.find((a) => a.id === id);
  if (exact) return ok(exact);
  const versions = snapshot.document.assets.filter((a) => slugOf(a.id) === slugOf(id));
  if (versions.length === 1) return ok(versions[0]);
  if (versions.length > 1) return err('invalid_request', `asset ${id} is ambiguous; use one of ${versions.map((v) => v.id).join(', ')}`);
  return err('not_found', `asset ${id} is not in this document`);
}

/** Images whose bytes would change if `fromAssetId` were replaced globally (reported before applying). */
export function affectedImages(snapshot: Snapshot, fromAssetId: string): string[] {
  return snapshot.document.pages.flatMap((p) => p.elements).filter((e) => e.kind === 'image' && e.assetId === fromAssetId).map((e) => e.id);
}

/** One image only. */
export const replaceImageAsset = (imageId: string, assetId: string): Operation[] => [{ op: 'set', target: imageId, patch: { assetId } }];

/** Every image using `fromAssetId`; explicit and separate from single-image replacement. */
export const replaceAssetEverywhere = (fromAssetId: string, toAssetId: string): Operation[] => [{ op: 'replaceAssetGlobal', fromAssetId, toAssetId }];
