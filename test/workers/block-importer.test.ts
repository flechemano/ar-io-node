import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { EventEmitter } from 'events';

import { BlockImporter } from '../../src/workers/block-importer.js';
import { StandaloneSqliteDatabase } from '../../src/database/standalone-sqlite.js';
import { ChainSource, JsonBlock, JsonTransaction } from '../../src/types.js';
import log from '../../src/log.js';
import { default as wait } from 'wait';

chai.use(chaiAsPromised);

class MockArweaveChainSource implements ChainSource {
  private height = 10000000;
  private missingTxIds: string[] = [];

  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const heightToId = JSON.parse(
      fs.readFileSync('test/mock_files/block_height_to_id.json', 'utf8')
    );

    const blockId = heightToId[height.toString()];
    if (fs.existsSync(`test/mock_files/blocks/${blockId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/blocks/${blockId}.json`, 'utf8')
      );
    }

    throw new Error(`Block ${height} not found`);
  }

  addMissingTxIds(txIds: string[]) {
    this.missingTxIds = this.missingTxIds.concat(txIds);
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    if (fs.existsSync(`test/mock_files/txs/${txId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8')
      );
    } else {
      throw new Error(`Transaction ${txId} not found`);
    }
  }

  async getBlockAndTxsByHeight(height: number) {
    const block = await this.getBlockByHeight(height);
    const txs = [];
    const missingTxIds = [];

    for (const txId of block.txs) {
      try {
        if (this.missingTxIds.includes(txId)) {
          missingTxIds.push(txId);
        } else {
          txs.push(await this.getTx(txId));
        }
      } catch (e) {
        missingTxIds.push(txId);
      }
    }

    return { block, txs, missingTxIds: missingTxIds };
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  setHeight(height: number) {
    this.height = height;
  }
}

describe('BlockImporter', () => {
  let metricsRegistry: promClient.Registry;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainSource: MockArweaveChainSource;
  let db: Sqlite.Database;
  let chainDb: StandaloneSqliteDatabase;

  const createBlockImporter = ({
    startHeight,
    heightPollingIntervalMs
  }: {
    startHeight: number;
    heightPollingIntervalMs?: number;
  }) => {
    return new BlockImporter({
      log: log,
      metricsRegistry,
      chainSource,
      chainDb,
      eventEmitter,
      startHeight,
      heightPollingIntervalMs
    });
  };

  beforeEach(async () => {
    log.transports.forEach((t) => (t.silent = true));
    metricsRegistry = promClient.register;
    metricsRegistry.clear();
    promClient.collectDefaultMetrics({ register: metricsRegistry });
    eventEmitter = new EventEmitter();
    chainSource = new MockArweaveChainSource();
    db = new Sqlite(':memory:');
    const schema = fs.readFileSync('schema.sql', 'utf8');
    db.exec(schema);
    chainDb = new StandaloneSqliteDatabase(db);
  });

  describe('importBlock', () => {
    describe('importing a block', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 982575 });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await chainDb.getMaxHeight();
        expect(maxHeight).to.equal(982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(1);
      });

      it('should add the block transactions to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newTxs).to.equal(3);
      });
    });

    describe('importing a block with missing transactions', () => {
      beforeEach(async () => {
        chainSource.addMissingTxIds([
          'oq-v4Cv61YAGmY_KlLdxmGp5HjcldvOSLOMv0UPjSTE'
        ]);
        blockImporter = createBlockImporter({ startHeight: 982575 });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await chainDb.getMaxHeight();
        expect(maxHeight).to.equal(982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(1);
      });

      it('should add the block transactions to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newTxs).to.equal(2);
      });

      it('should add the IDs of the missing transactions to DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.missingTxs).to.equal(1);
      });
    });

    describe('attempting to import a block with a gap before it', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        await blockImporter.importBlock(1);
        await blockImporter.importBlock(6);
      });

      it('should import the first block at the start of the gap', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(2);
      });

      it('should import only 1 block', async () => {
        const maxHeight = await chainDb.getMaxHeight();
        expect(maxHeight).to.equal(2);
      });
    });

    describe('attempting to import a block following a gap that exceeds the max fork depth', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 0 });
      });

      it('should throw an exception', async () => {
        // TODO add blocks 52 and 53 and use those instead
        expect(blockImporter.importBlock(51)).to.be.rejectedWith(
          'Maximum fork depth exceeded'
        );
      });
    });
  });

  describe('getNextHeight', () => {
    describe('when no blocks have been imported', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 0 });
      });

      it('should return the start height', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        expect(nextHeight).to.equal(0);
      });
    });

    describe('when blocks have been imported but the chain is not fully synced', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        await blockImporter.importBlock(1);
      });

      it('should return one more than the max height in the DB', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        expect(nextHeight).to.equal(2);
      });
    });

    describe('when the chain is fully synced', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({
          startHeight: 1,
          heightPollingIntervalMs: 5
        });
        chainSource.setHeight(1);
        await blockImporter.importBlock(1);
      });

      it('should wait for the next block to be produced', async () => {
        const nextHeightPromise = blockImporter.getNextHeight();

        const getNextHeightWaited = await Promise.race([
          (async () => {
            await wait(1);
            return true;
          })(),
          (async () => {
            await nextHeightPromise;
            return false;
          })()
        ]);
        expect(getNextHeightWaited).to.be.true;

        chainSource.setHeight(2);
        expect(await nextHeightPromise).to.equal(2);
      });

      it('should return one more than the max height in the DB if multiple blocks are produced while waiting', async () => {
        const nextHeightPromise = blockImporter.getNextHeight();
        chainSource.setHeight(3);
        expect(await nextHeightPromise).to.equal(2);
      });
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 1 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      blockImporter.start();
      await wait(5);
      blockImporter.stop();
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 0 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      await blockImporter.stop();
    });
  });
});
