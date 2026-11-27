/** СОГЛАСОВАНО: логическая частота HOT-симуляции. */
export const SIMULATION_HZ = 20;

/** СОГЛАСОВАНО: единственный шаг интеграции движения, в секундах. */
export const FIXED_DT = 0.05;

/** Период планировщика; не заменяет FIXED_DT при отставании event loop. */
export const FIXED_DT_MS = 50;
