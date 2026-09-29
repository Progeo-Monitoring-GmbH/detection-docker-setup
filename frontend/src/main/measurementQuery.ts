/** Query string for the measurements endpoints: a whole year, or the latest 300. */
export const measurementsQuery = (year?: number) =>
  new URLSearchParams(year ? { year: String(year) } : { limit: '300' }).toString();
