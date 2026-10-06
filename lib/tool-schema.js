// 工具参数 schema 的自检。
//
// 为什么需要它：手写注册的工具（ctx.tools.register）的参数是**标准 JSON Schema**，
// 会被原样发给模型服务商。而 defineTool 那条路接受的是 DSH 内部 spec，属性上写
// `required: true`。两者混用会直接把 `required: true` 发出去，服务商报：
//   Invalid schema for function 'user_style': true is not of type "array"
// 这不是「工具不可用」，而是**每一次请求都失败**——用户的对话会被整个打断。
//
// 所以：注册前先自检；不通过就不注册工具，只留一条诊断。宁可少一个工具，也不能让插件
// 把用户的对话搞挂。

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/**
 * 自检工具参数 schema。
 * @param parameters - 待注册的 parameters 对象。
 * @returns {{ok: boolean, problems: string[]}} 不通过时给出可直接定位的问题列表。
 */
export function validateToolParameters(parameters) {
  const problems = []

  function walk(node, path, depth) {
    if (depth > 8) {
      problems.push(`${path}: 嵌套过深（>8 层）`)
      return
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${path}: 必须是对象`)
      return
    }

    // 正是这条把上次的故障抓出来：required 只能是字符串数组，绝不能是布尔值。
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required)) {
        problems.push(`${path}.required: 必须是字符串数组（标准 JSON Schema），实际是 ${JSON.stringify(node.required)}`)
      } else if (node.required.some((name) => typeof name !== 'string')) {
        problems.push(`${path}.required: 数组元素必须全是字符串`)
      }
    }

    if (Object.hasOwn(node, 'type')) {
      if (typeof node.type !== 'string') problems.push(`${path}.type: 必须是字符串`)
      else if (!ALLOWED_TYPES.has(node.type)) problems.push(`${path}.type: 不支持的类型 ${JSON.stringify(node.type)}`)
    }

    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      problems.push(`${path}.additionalProperties: 必须是布尔值`)
    }

    if (Object.hasOwn(node, 'enum') && !Array.isArray(node.enum)) {
      problems.push(`${path}.enum: 必须是数组`)
    }

    if (node.type === 'array') {
      if (!node.items) problems.push(`${path}.items: type 为 array 时必须给出 items`)
      else walk(node.items, `${path}.items`, depth + 1)
    }

    if (node.properties !== undefined) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        problems.push(`${path}.properties: 必须是对象`)
      } else {
        for (const [name, child] of Object.entries(node.properties)) {
          walk(child, `${path}.properties.${name}`, depth + 1)
          // 属性上出现 required 是 DSH 内部 spec 的写法，这里必须拒绝。
          if (child && typeof child === 'object' && Object.hasOwn(child, 'required')) {
            problems.push(`${path}.properties.${name}.required: 属性级 required 是 defineTool spec 的写法，手写注册必须改用外层 required 数组`)
          }
        }
        if (Array.isArray(node.required)) {
          for (const name of node.required) {
            if (typeof name === 'string' && !Object.hasOwn(node.properties, name)) {
              problems.push(`${path}.required: 点名了不存在的属性 ${JSON.stringify(name)}`)
            }
          }
        }
      }
    }
  }

  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    problems.push('parameters: 必须是对象')
  } else {
    if (parameters.type !== 'object') problems.push('parameters.type: 顶层必须是 "object"')
    if (!parameters.properties || typeof parameters.properties !== 'object') problems.push('parameters.properties: 顶层必须给出 properties')
    walk(parameters, 'parameters', 0)
  }

  return { ok: problems.length === 0, problems }
}
