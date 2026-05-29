# Game Integration Guide: Standardizing Game States and Normalization

This integration guide explains the standard interface contract, naming conventions, and card normalization rules required to integrate new game types into the `eyes` module. Following this guide ensures that any new game engine or data interceptor communicates with `tableManager.js` without issues.

---

## 🚨 Critical Interface Contract

The server-side State Manager ([tableManager.js](file:///c:/Users/desmo/Desktop/v4-template/eyes/tableManager.js)) expects the interceptor to cache client-side WebSocket / Pinia / Socket.io packets and translate them into a 100% standardized schema. 

Every parsed table state object must conform to this exact shape:

```typescript
interface StandardizedTableState {
  /** The primary key map identifier (e.g., "PrettyMG05") */
  tableName: string;

  /** Database or API lookup room ID (e.g., "BAC-005") */
  tableId: string | null;

  /** 
   * Unique ID for the current game round (maps from server gameId).
   * Changes in roundId are used by tableManager to detect new shoes/rounds.
   */
  roundId: string | null;

  /** 
   * Normalized game state. 
   * Supported: "Waiting for Bets", "Dealing", "Result", "Shuffling".
   * Note: Result states must include the "Result" suffix or be exactly "Result".
   */
  state: string;

  /** Remaining seconds for betting, or -1 when betting is closed/inactive */
  timer: number;

  /** Current round number (1-based index) */
  round: number;

  /** Cumulative shoe statistics */
  wins: {
    P: number; // Player wins
    B: number; // Banker wins
    T: number; // Tie wins
  };

  /** Normalized array of Player cards (e.g., ["8D", "7H"]) */
  playerCards: string[];

  /** Normalized array of Banker cards (e.g., ["9S", "QD"]) */
  bankerCards: string[];

  /** Combined array of all cards dealt in the current round */
  allCards: string[];

  /** Final hand outcome letter ("P" | "B" | "T" | null) */
  winner: "P" | "B" | "T" | null;

  /** Bead road statistics history array representing previous round outcomes */
  statistics: string[];
}
```

---

## 🎴 Card Normalization Rules

To ensure correct card identification and hand evaluation, card strings must follow a strict representation scheme:

> [!IMPORTANT]
> **Syntax Pattern**: `[Rank][Suit]` (e.g., `"AH"`, `"9D"`, `"TC"`, `"KS"`)

1. **Rank Representation**:
   * Must be a single uppercase character.
   * `A` = Ace, `2`-`9` = Numeric ranks, `T` = **10** (Normalized to "T" so all ranks are single-character), `J` = Jack, `Q` = Queen, `K` = King.
   * **Rule Exception**: Ten MUST be represented as `T`, never `10`. This allows `tableManager.js` to parse card components simply by slicing the last character as the suit: `cardName.slice(0, -1)`.

2. **Suit Representation**:
   * Must be a single uppercase character matching the standard suits:
     * `H` = Hearts
     * `D` = Diamonds
     * `C` = Clubs
     * `S` = Spades

3. **Filtering**:
   * Any empty cards, placeholders, or invalid values (e.g., `"null"`, `"Red"`, `undefined`, `null`) **must** be filtered out from the card arrays before sending them to `tableManager.js`.

---

## ⏱️ Game State Conventions

The game state machine relies on these exact string states to track game phases:

| Phase | State Value | Details |
| :--- | :--- | :--- |
| **Betting Active** | `"Waiting for Bets"` | Activates EV calculations, bet timers, and accepts placements. |
| **Betting Closed / Action** | `"Dealing"` | Cards are being dealt. Bets are no longer accepted. |
| **Settlement** | `"Result"` or `"Result[Suffix]"` | Triggers outcome evaluation, payouts, and saves telemetry signals. |
| **Shoe Reset** | `"Shuffling"` | Clears active shoe state, resets round counters. |

---

## 🛠️ Step-by-Step: Integrating a New Game Type

If you are adding a new game type (e.g., Roulette, Dragon Tiger, Sic Bo) under the `eyes` module, follow this integration pipeline:

```mermaid
graph TD
    A[Capture WS/REST Packets in Interceptor] --> B[Map Raw Room IDs to Table Names]
    B --> C[Extract Raw Game Round & State Information]
    C --> D[Normalize Cards using [Rank][Suit] Format]
    D --> E[Construct StandardizedTableState Output]
    E --> F[Inject state to tableManager.js via Event Dispatch]
```

### 1. Intercept Raw Network Packets
Use the existing WebSocket / Socket.io hook inside [interceptor.js](file:///c:/Users/desmo/Desktop/v4-template/eyes/interceptor.js) to catch network packets sent from the game server.

### 2. Map Room IDs
Ensure there is a translation map (like `window.__roomToNameMap`) mapping the raw server room ID to a clean user-friendly table name (e.g., `BAC-005` to `PrettyMG05`).

### 3. Normalize & Package
Implement a translator inside the client-side module to convert the raw JSON data into the `StandardizedTableState` contract.

### 4. Dispatch to State Manager
Ensure the event listener in [runEyes.js](file:///c:/Users/desmo/Desktop/v4-template/eyes/runEyes.js) captures the output and sends it directly to `tableManager.js` to trigger automated system telemetry.
