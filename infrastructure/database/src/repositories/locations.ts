import { asc, eq } from 'drizzle-orm';

import type { LocationDefinition, LocationId } from '@mnemosin/contracts';
import type { LocationRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { locationFromRow, locationToRow } from '../mappers/state-mappers.js';
import { locations } from '../schema.js';

export class SqlLocationRepository implements LocationRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async upsert(location: LocationDefinition): Promise<void> {
    const row = locationToRow(location);
    await this.q.insert(locations).values(row).onConflictDoUpdate({ target: locations.locationId, set: row }).run();
  }

  async findById(locationId: LocationId): Promise<LocationDefinition | null> {
    const rows = await this.q.select().from(locations).where(eq(locations.locationId, locationId)).limit(1);
    return rows[0] ? locationFromRow(rows[0]) : null;
  }

  async listAll(): Promise<LocationDefinition[]> {
    const rows = await this.q.select().from(locations).orderBy(asc(locations.name));
    return rows.map(locationFromRow);
  }

  async count(): Promise<number> {
    const rows = await this.q.select().from(locations);
    return rows.length;
  }
}
