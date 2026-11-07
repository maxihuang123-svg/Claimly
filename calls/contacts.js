import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// Every attempt to reach a claimant, with what they said. Append-only like the review log:
// a contact is created once and then patched as the call progresses.
// What a claimant says is stored here, never written into the case.
export class ContactLog {
  constructor(path) {
    this.path = path;
    this.byId = new Map();
    if (!existsSync(path)) return;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        this.#apply(JSON.parse(line));
      } catch {
        console.warn(`Skipping unreadable line ${index + 1} in ${path}`);
      }
    });
  }

  #apply(event) {
    if (event.event === 'contact') this.byId.set(event.contact.id, event.contact);
    if (event.event === 'update' && this.byId.has(event.id)) {
      this.byId.set(event.id, { ...this.byId.get(event.id), ...event.patch });
    }
  }

  #write(event) {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    this.#apply(event);
  }

  all() {
    return [...this.byId.values()];
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  add(fields) {
    const contact = {
      id: randomUUID(), created_at: new Date().toISOString(), conversation_id: null, error: null, result: null, ...fields,
    };
    this.#write({ event: 'contact', contact });
    return contact;
  }

  update(id, patch) {
    this.#write({ event: 'update', id, at: new Date().toISOString(), patch });
    return this.get(id);
  }
}
