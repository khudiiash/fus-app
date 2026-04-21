/**
 * FUS: js-minecraft historically shipped a full Three bundle here. The app uses npm `three`
 * (see package.json, same as Block World) so importers get one shared WebGL stack.
 */
export * from 'three'
