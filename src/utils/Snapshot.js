
import {
  isDeleted,
  createDeleteSetFromStructStore,
  getStateVector,
  getItemCleanStart,
  iterateDeletedStructs,
  writeDeleteSet,
  writeStateVector,
  readDeleteSet,
  readStateVector,
  createDeleteSet,
  createID,
  getState,
  findIndexSS,
  UpdateEncoderV2,
  applyUpdateV2,
  DSEncoderV1, DSEncoderV2, DSDecoderV1, DSDecoderV2, Transaction, Doc, DeleteSet, Item // eslint-disable-line
} from '../internals.js'

import * as map from 'lib0/map'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

export class Snapshot {
  /**
   * @param {DeleteSet} ds
   * @param {Map<number,number>} sv state map
   */
  constructor (ds, sv) {
    /**
     * @type {DeleteSet}
     */
    this.ds = ds
    /**
     * State Map
     * @type {Map<number,number>}
     */
    this.sv = sv
  }
}

/**
 * @param {Snapshot} snap1
 * @param {Snapshot} snap2
 * @return {boolean}
 */
export const equalSnapshots = (snap1, snap2) => {
  const ds1 = snap1.ds.clients
  const ds2 = snap2.ds.clients
  const sv1 = snap1.sv
  const sv2 = snap2.sv
  if (sv1.size !== sv2.size || ds1.size !== ds2.size) {
    return false
  }
  for (const [key, value] of sv1.entries()) {
    if (sv2.get(key) !== value) {
      return false
    }
  }
  for (const [client, dsitems1] of ds1.entries()) {
    const dsitems2 = ds2.get(client) || []
    if (dsitems1.length !== dsitems2.length) {
      return false
    }
    for (let i = 0; i < dsitems1.length; i++) {
      const dsitem1 = dsitems1[i]
      const dsitem2 = dsitems2[i]
      if (dsitem1.clock !== dsitem2.clock || dsitem1.len !== dsitem2.len) {
        return false
      }
    }
  }
  return true
}

/**
 * @param {Snapshot} snapshot
 * @param {DSEncoderV1 | DSEncoderV2} [encoder]
 * @return {Uint8Array}
 */
export const encodeSnapshotV2 = (snapshot, encoder = new DSEncoderV2()) => {
  writeDeleteSet(encoder, snapshot.ds)
  writeStateVector(encoder, snapshot.sv)
  return encoder.toUint8Array()
}

/**
 * @param {Snapshot} snapshot
 * @return {Uint8Array}
 */
export const encodeSnapshot = snapshot => encodeSnapshotV2(snapshot, new DSEncoderV1())

/**
 * @param {Uint8Array} buf
 * @param {DSDecoderV1 | DSDecoderV2} [decoder]
 * @return {Snapshot}
 */
export const decodeSnapshotV2 = (buf, decoder = new DSDecoderV2(decoding.createDecoder(buf))) => {
  return new Snapshot(readDeleteSet(decoder), readStateVector(decoder))
}

/**
 * @param {Uint8Array} buf
 * @return {Snapshot}
 */
export const decodeSnapshot = buf => decodeSnapshotV2(buf, new DSDecoderV1(decoding.createDecoder(buf)))

/**
 * @param {DeleteSet} ds
 * @param {Map<number,number>} sm
 * @return {Snapshot}
 */
export const createSnapshot = (ds, sm) => new Snapshot(ds, sm)

export const emptySnapshot = createSnapshot(createDeleteSet(), new Map())

/**
 * @param {Doc} doc
 * @return {Snapshot}
 */
export const snapshot = doc => createSnapshot(createDeleteSetFromStructStore(doc.store), getStateVector(doc.store))

/**
 * @param {Item} item
 * @param {Snapshot|undefined} snapshot
 *
 * @protected
 * @function
 */
export const isVisible = (item, snapshot) => snapshot === undefined
  ? !item.deleted
  : snapshot.sv.has(item.id.client) && (snapshot.sv.get(item.id.client) || 0) > item.id.clock && !isDeleted(snapshot.ds, item.id)

/**
 * @param {Transaction} transaction
 * @param {Snapshot} snapshot
 */
export const splitSnapshotAffectedStructs = (transaction, snapshot) => {
  const meta = map.setIfUndefined(transaction.meta, splitSnapshotAffectedStructs, new Set())
  const store = transaction.doc.store
  // check if we already split for this snapshot
  if (!meta.has(snapshot)) {
    snapshot.sv.forEach((clock, client) => {
      if (clock < getState(store, client)) {
        getItemCleanStart(transaction, createID(client, clock))
      }
    })
    iterateDeletedStructs(transaction, snapshot.ds, item => {})
    meta.add(snapshot)
  }
}

/**
 * @param {Doc} originDoc
 * @param {Snapshot} snapshot
 * @param {Doc} [newDoc] Optionally, you may define the Yjs document that receives the data from originDoc
 * @return {Doc}
 */
export const createDocFromSnapshot = (originDoc, snapshot, newDoc = new Doc()) => {
  if (originDoc.gc) {
    // we should not try to restore a GC-ed document, because some of the restored items might have their content deleted
    throw new Error('originDoc must not be garbage collected')
  }
  const { sv, ds } = snapshot

  const encoder = new UpdateEncoderV2()
  originDoc.transact(transaction => {
    let size = 0
    sv.forEach(clock => {
      if (clock > 0) {
        size++
      }
    })
    encoding.writeVarUint(encoder.restEncoder, size)
    // splitting the structs before writing them to the encoder
    for (const [client, clock] of sv) {
      if (clock === 0) {
        continue
      }
      if (clock < getState(originDoc.store, client)) {
        getItemCleanStart(transaction, createID(client, clock))
      }
      const structs = originDoc.store.clients.get(client) || []
      const lastStructIndex = findIndexSS(structs, clock - 1)
      // write # encoded structs
      encoding.writeVarUint(encoder.restEncoder, lastStructIndex + 1)
      encoder.writeClient(client)
      // first clock written is 0
      encoding.writeVarUint(encoder.restEncoder, 0)
      for (let i = 0; i <= lastStructIndex; i++) {
        structs[i].write(encoder, 0)
      }
    }
    writeDeleteSet(encoder, ds)
  })

  applyUpdateV2(newDoc, encoder.toUint8Array(), 'snapshot')
  return newDoc
}
