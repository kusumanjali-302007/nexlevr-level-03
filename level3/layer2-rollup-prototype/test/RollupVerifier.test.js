const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RollupVerifier (smart contract)", function () {
  let verifier, sequencer, other;
  const commitment1 = ethers.keccak256(ethers.toUtf8Bytes("batch 1"));
  const commitment2 = ethers.keccak256(ethers.toUtf8Bytes("batch 2"));

  beforeEach(async function () {
    [sequencer, other] = await ethers.getSigners();
    verifier = await ethers.deployContract("RollupVerifier", [sequencer.address]);
  });

  it("starts empty with the deployer as sequencer", async function () {
    expect(await verifier.sequencer()).to.equal(sequencer.address);
    expect(await verifier.batchCount()).to.equal(0n);
    expect(await verifier.nextBatchNumber()).to.equal(1n);
  });

  it("submits a batch, stores it, and emits BatchSubmitted", async function () {
    await expect(verifier.submitBatch(1, commitment1, 3))
      .to.emit(verifier, "BatchSubmitted")
      .withArgs(1, commitment1, sequencer.address, 3);

    expect(await verifier.batchCount()).to.equal(1n);
    expect(await verifier.batchExists(1)).to.equal(true);
    const [commitment, txCount, submitter] = await verifier.getBatch(1);
    expect(commitment).to.equal(commitment1);
    expect(txCount).to.equal(3n);
    expect(submitter).to.equal(sequencer.address);
  });

  it("verifies a matching commitment and rejects a wrong or unknown one", async function () {
    await verifier.submitBatch(1, commitment1, 2);
    expect(await verifier.verifyBatch(1, commitment1)).to.equal(true);
    expect(await verifier.verifyBatch(1, commitment2)).to.equal(false); // wrong commitment
    expect(await verifier.verifyBatch(2, commitment1)).to.equal(false); // batch not recorded
  });

  it("rejects duplicate batch submissions", async function () {
    await verifier.submitBatch(1, commitment1, 2);
    await expect(verifier.submitBatch(1, commitment2, 2)).to.be.revertedWith("Batch already submitted");
  });

  it("rejects out-of-order batch numbers", async function () {
    await expect(verifier.submitBatch(2, commitment1, 2)).to.be.revertedWith("Batch number out of order");
    await verifier.submitBatch(1, commitment1, 2);
    await expect(verifier.submitBatch(3, commitment2, 2)).to.be.revertedWith("Batch number out of order");
  });

  it("rejects unauthorized submissions", async function () {
    await expect(verifier.connect(other).submitBatch(1, commitment1, 2)).to.be.revertedWith("Only sequencer");
  });

  it("rejects empty commitments and empty batches", async function () {
    await expect(verifier.submitBatch(1, ethers.ZeroHash, 2)).to.be.revertedWith("Empty commitment");
    await expect(verifier.submitBatch(1, commitment1, 0)).to.be.revertedWith("Empty batch");
  });

  it("reverts when reading a batch that does not exist", async function () {
    await expect(verifier.getBatch(1)).to.be.revertedWith("Batch not found");
  });

  it("lets the sequencer hand over the role", async function () {
    await expect(verifier.transferSequencer(other.address))
      .to.emit(verifier, "SequencerChanged")
      .withArgs(sequencer.address, other.address);
    await expect(verifier.submitBatch(1, commitment1, 1)).to.be.revertedWith("Only sequencer");
    await verifier.connect(other).submitBatch(1, commitment1, 1);
    await expect(verifier.connect(other).transferSequencer(ethers.ZeroAddress)).to.be.revertedWith(
      "Sequencer is zero address"
    );
  });
});
