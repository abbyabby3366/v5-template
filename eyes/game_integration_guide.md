# Game Integration Guide: Standardizing Game States and Normalization

This integration guide explains the standard interface contract, naming conventions, card normalization rules, and session launching required to integrate new game types into the `eyes` module. Following this guide ensures that any new game engine or data interceptor communicates with `tableManager.js` without issues.

---

## 🚨 Critical Interface Contract

The server-side State Manager ([tableManager.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/tableManager.js)) expects the interceptor to cache client-side WebSocket / Pinia / Socket.io packets and translate them into a 100% standardized schema. 

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

  /** 
   * Optional. The last EV calculation result attached by the EV Calculator.
   * If not calculated yet or invalid, this will be null.
   */
  lastEvResult?: EVResult | null;
}

interface EVResult {
  p_player: number;       // Probability of Player win (0.0 to 1.0)
  p_banker: number;       // Probability of Banker win (0.0 to 1.0)
  p_tie: number;          // Probability of Tie win (0.0 to 1.0)
  ev_player_base: number; // Base EV for Player bet
  ev_banker_base: number; // Base EV for Banker bet
  ev_player: number;      // Adjusted EV for Player (with rebate applied)
  ev_banker: number;      // Adjusted EV for Banker (with rebate applied)
  ev_tie: number;         // Adjusted EV for Tie (with rebate applied)
  rebate: number;         // Rebate rate used for calculations (e.g., 0.012)
  remaining: number;      // Total remaining cards in the active shoe
  best: {                 // Recommends the highest EV bet target exceeding minimum threshold
    target: "Player" | "Banker";
    ev: number;
    prob: number;
  } | null;               // Null if no edge exceeds threshold
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

### 🧮 Deck Composition & EV Mapping

The card normalization directly feeds the EV calculation engine in [evCalculator.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/evCalculator.js). The Rust-based analyzer requires a 13-slot integer array representing the counts of remaining cards for each rank in the shoe.

The single-character normalized ranks map directly to composition array indices as follows:

| Index | Rank | Description | Example Standardized Cards |
| :--- | :--- | :--- | :--- |
| **0** | `A` | Ace | `"AH"`, `"AD"`, `"AC"`, `"AS"` |
| **1** | `2` | Two | `"2H"`, `"2D"`, `"2C"`, `"2S"` |
| **2** | `3` | Three | `"3H"`, `"3D"`, `"3C"`, `"3S"` |
| **3** | `4` | Four | `"4H"`, `"4D"`, `"4C"`, `"4S"` |
| **4** | `5` | Five | `"5H"`, `"5D"`, `"5C"`, `"5S"` |
| **5** | `6` | Six | `"6H"`, `"6D"`, `"6C"`, `"6S"` |
| **6** | `7` | Seven | `"7H"`, `"7D"`, `"7C"`, `"7S"` |
| **7** | `8` | Eight | `"8H"`, `"8D"`, `"8C"`, `"8S"` |
| **8** | `9` | Nine | `"9H"`, `"9D"`, `"9C"`, `"9S"` |
| **9** | `T` | Ten | `"TH"`, `"TD"`, `"TC"`, `"TS"` |
| **10**| `J` | Jack | `"JH"`, `"JD"`, `"JC"`, `"JS"` |
| **11**| `Q` | Queen | `"QH"`, `"QD"`, `"QC"`, `"QS"` |
| **12**| `K` | King | `"KH"`, `"KD"`, `"KC"`, `"KS"` |

Correct normalization is vital; a single parsing failure (e.g., passing `"10S"` instead of `"TS"`) will cause composition misalignment and invalidate all generated downstream EV calculations.

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
    A[Launch Browser & Initialize Session] --> B[Capture WS/REST Packets in Interceptor]
    B --> C[Map Raw Room IDs to Table Names]
    C --> D[Extract Raw Game Round & State Information]
    D --> E[Normalize Cards using [Rank][Suit] Format]
    E --> F[Construct StandardizedTableState Output]
    F --> G[Inject state to tableManager.js via Event Dispatch]
```

### 1. Launch Browser & Initialize Session
Before intercepting packets, the browser context must launch the target game lobby and establish an active authenticated session. 
* Use the reusable lobby login structure as implemented in [demoLogin.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/demoLogin.js) as a blueprint.
* The utility handles opening a new page, navigating to the Cloudfront lobby URL, waiting for the page to reach `networkidle2`, and validating that no crash/error dialogs are active via `checkPageErrors`.

### 2. Intercept Raw Network Packets
Use the existing WebSocket / Socket.io hook inside [interceptor.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/interceptor.js) to catch network packets sent from the game server.

### 3. Map Room IDs
Ensure there is a translation map (like `window.__roomToNameMap`) mapping the raw server room ID to a clean user-friendly table name (e.g., `BAC-005` to `PrettyMG05`).

### 4. Normalize & Package
Implement a translator inside the client-side module to convert the raw JSON data into the `StandardizedTableState` contract. Ensure cards match the `[Rank][Suit]` rule so that they correctly subtract from the 13-slot deck composition.

### 5. Dispatch to State Manager
Ensure the event listener in [runEyes.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/runEyes.js) captures the output and sends it directly to `tableManager.js` to trigger automated system telemetry and EV calculations.
