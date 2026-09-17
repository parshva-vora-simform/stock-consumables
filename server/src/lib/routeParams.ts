/**
 * The Express placeholder for a path id.
 *
 * The route builders in `@stock/shared` take an id and return a concrete path;
 * Express wants the same shape with `:id` where the value goes. Passing this
 * constant means the server registers exactly the paths the client calls,
 * derived from one definition — `API.items.detail(ID_PARAM)` is `/items/:id`.
 */
export const ID_PARAM = ':id';
