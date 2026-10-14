import type { LocationDefinition } from '@mnemosin/contracts';
import type { LocationId } from '@mnemosin/contracts';

export interface LocationRepository {
  upsert(location: LocationDefinition): Promise<void>;
  findById(locationId: LocationId): Promise<LocationDefinition | null>;
  listAll(): Promise<LocationDefinition[]>;
  count(): Promise<number>;
}
