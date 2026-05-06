import type { Game } from "boardgame.io";

export interface TicTacToeState {
  cells: (string | null)[];
}

const TicTacToe: Game<TicTacToeState> = {
  name: "tic-tac-toe",
  minPlayers: 2,
  maxPlayers: 2,

  setup: () => ({
    cells: Array(9).fill(null),
  }),

  moves: {
    clickCell: ({ G, playerID }, id: number) => {
      if (G.cells[id] !== null) {
        return "INVALID_MOVE" as unknown as void;
      }
      G.cells[id] = playerID;
    },
  },

  endIf: ({ G, ctx }) => {
    const cells = G.cells;
    const lines = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ];

    for (const [a, b, c] of lines) {
      if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
        return { winner: cells[a] };
      }
    }

    if (cells.every((c) => c !== null)) {
      return { draw: true };
    }

    if (ctx.turn > 9) {
      return { draw: true };
    }
  },
};

export default TicTacToe;
