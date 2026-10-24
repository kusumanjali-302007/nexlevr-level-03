// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title RollupVerifier
 * @notice EDUCATIONAL PROTOTYPE. Records batch commitments produced by an off-chain
 *         rollup client and lets anyone check whether a commitment matches a recorded batch.
 *
 * IMPORTANT: this contract does NOT verify that a batch is valid. It only stores a hash.
 * Real rollups add fraud proofs (optimistic) or validity proofs (zero-knowledge) on top
 * of this idea. See README.md for the limitations.
 */
contract RollupVerifier {
    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    /// @dev What we remember about every submitted batch.
    struct BatchRecord {
        bytes32 commitment; // hash that summarises the whole batch
        uint256 txCount;    // number of transactions in the batch
        address submitter;  // who submitted it
        uint256 timestamp;  // block timestamp of submission
        bool exists;        // true once the batch has been stored
    }

    /// @notice The only address allowed to submit batches (the "sequencer").
    address public sequencer;

    /// @notice How many batches have been recorded so far (batch numbers start at 1).
    uint256 public batchCount;

    mapping(uint256 => BatchRecord) private batches;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BatchSubmitted(
        uint256 indexed batchNumber,
        bytes32 indexed commitment,
        address indexed submitter,
        uint256 txCount
    );

    event SequencerChanged(address indexed oldSequencer, address indexed newSequencer);

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    modifier onlySequencer() {
        require(msg.sender == sequencer, "Only sequencer");
        _;
    }

    constructor(address initialSequencer) {
        require(initialSequencer != address(0), "Sequencer is zero address");
        sequencer = initialSequencer;
        emit SequencerChanged(address(0), initialSequencer);
    }

    // ---------------------------------------------------------------------
    // Write functions
    // ---------------------------------------------------------------------

    /**
     * @notice Record the commitment of a new batch.
     * @param batchNumber Must equal batchCount + 1 (batches are recorded in order).
     * @param commitment  Hash of the batch, computed off-chain by the rollup client.
     * @param txCount     Number of transactions in the batch (must be > 0).
     */
    function submitBatch(uint256 batchNumber, bytes32 commitment, uint256 txCount)
        external
        onlySequencer
    {
        require(commitment != bytes32(0), "Empty commitment");
        require(txCount > 0, "Empty batch");
        require(!batches[batchNumber].exists, "Batch already submitted");
        require(batchNumber == batchCount + 1, "Batch number out of order");

        batches[batchNumber] = BatchRecord({
            commitment: commitment,
            txCount: txCount,
            submitter: msg.sender,
            timestamp: block.timestamp,
            exists: true
        });
        batchCount = batchNumber;

        emit BatchSubmitted(batchNumber, commitment, msg.sender, txCount);
    }

    /// @notice Hand the sequencer role to another address.
    function transferSequencer(address newSequencer) external onlySequencer {
        require(newSequencer != address(0), "Sequencer is zero address");
        emit SequencerChanged(sequencer, newSequencer);
        sequencer = newSequencer;
    }

    // ---------------------------------------------------------------------
    // Read functions
    // ---------------------------------------------------------------------

    /// @notice The batch number the next submission must use.
    function nextBatchNumber() external view returns (uint256) {
        return batchCount + 1;
    }

    /// @notice True if a batch with this number has been recorded.
    function batchExists(uint256 batchNumber) external view returns (bool) {
        return batches[batchNumber].exists;
    }

    /// @notice Does `commitment` match the one recorded for `batchNumber`?
    function verifyBatch(uint256 batchNumber, bytes32 commitment) external view returns (bool) {
        BatchRecord storage record = batches[batchNumber];
        return record.exists && record.commitment == commitment;
    }

    /// @notice Read everything stored about a batch. Reverts if it does not exist.
    function getBatch(uint256 batchNumber)
        external
        view
        returns (bytes32 commitment, uint256 txCount, address submitter, uint256 timestamp)
    {
        BatchRecord storage record = batches[batchNumber];
        require(record.exists, "Batch not found");
        return (record.commitment, record.txCount, record.submitter, record.timestamp);
    }
}
