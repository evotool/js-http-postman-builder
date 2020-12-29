import type { BodyType, BuiltEndpoint, HttpMethod, JsonData } from '@evojs/http';
import { ParamSchema } from '@evojs/http/decorators/Endpoint';
import type { PrimitiveRule, ValidationRule, ValidationSchema } from '@evojs/validator';
import * as util from 'util';

function keyLength(object: { [key: string]: any }): number {
	let count = 0;

	for (const p in object) {
		if (!object.hasOwnProperty(p) || object[p] === undefined) {
			continue;
		}

		count++;
	}

	return count;
}

function inspect(object: { [key: string]: any }, linebreaks: boolean = false): string | undefined {
	if (keyLength(object) === 0) {
		return;
	}

	object = { ...object };

	for (const p in object) {
		if (!object.hasOwnProperty(p) || object[p] !== undefined) {
			continue;
		}

		delete object[p];
	}

	const out = util.inspect(object, false, null, false);

	if (linebreaks) {
		return out;
	}

	return out.replace(/\n+ */g, ' ');
}

function parseQueryRule(rule: PrimitiveRule): string {
	if (rule) {
		if (typeof rule.default === 'string' || typeof rule.default === 'number') {
			return rule.default?.toString() || '';
		} else if (typeof rule.default === 'boolean') {
			return rule.default ? '1' : '0';
		}

		if ('values' in rule && rule.values) {
			return rule.values[0]?.toString() || '';
		}

		switch (rule.type) {
			case 'string':
				return '';
			case 'number':
				if (rule.integer) {
					return '0';
				}

				return '0.0';

			case 'boolean':
				return '0';

			default:
				return '';
		}
	}

	return '';
}

function parseLocation(
	path: string,
	param: ParamSchema,
	paramOrder: string[],
	maxFolders: number = 2,
): { folders: string[]; url: string; host: string[]; path: string[]; variable: Variable[] } {
	const paths = path.substring(1).split('/');
	const folders = paths.slice(0, maxFolders);

	path = paths.map((p) => {
		let match: RegExpExecArray | null;

		if (match = (/^:([a-z_$][a-z0-9_$]*)(\(.*\))?$/i).exec(p)) {
			const [param] = Array.from(match).slice(1);

			return `:${param}`;
		}

		return p;
	}).join('/');

	const variable: Variable[] = [];

	for (const key of paramOrder) {
		variable.push({ key, value: '', description: inspect(param[key]) });
	}

	const url = `{{host}}/${path}`;
	const host = ['{{host}}'];

	return { folders, url, host, path: path.split('/'), variable };
}

function parseQuery(query?: ValidationSchema): Query[] {
	const out: Query[] = [];

	if (query) {
		out.push(...Object
			.entries(query)
			.map(([key, value]) => {
				const rule = (Array.isArray(value) ? (value as PrimitiveRule[])[0]! : value) as PrimitiveRule;
				const description: string | undefined = inspect(value);

				return { key, value: parseQueryRule(rule), description };
			}));
	}

	return out;
}

function parseRuleToJsonData(validationRule: ValidationRule): JsonData {
	const primitiveRule = Array.isArray(validationRule) ? validationRule[0] as PrimitiveRule : validationRule;

	if (typeof primitiveRule.default !== 'undefined' && typeof primitiveRule.default !== 'function') {
		return primitiveRule.default;
	}

	switch (primitiveRule.type) {
		case 'string':
			return primitiveRule.values ? primitiveRule.values[0] || '' : '';
		case 'number': {
			const v = primitiveRule.values ? primitiveRule.values[0] : undefined;

			return isFinite(v!) ? v! : 0;
		}

		case 'boolean':
			return false;
		case 'object':
			return primitiveRule.schema ? Object.entries(primitiveRule.schema).reduce((p, [key, rule]) => ({ ...p, [key]: parseRuleToJsonData(rule) }), {}) : {};
		case 'array': {
			const out: JsonData[] = [];

			if (primitiveRule.schema) {
				for (let i = 0, a = primitiveRule.schema, r = a[i], l = primitiveRule.nested && primitiveRule.length! > a.length ? primitiveRule.length! : a.length; i < l; r = a[++i]) {
					if (i < a.length) {
						out.push(parseRuleToJsonData(r));
					} else {
						out.push(primitiveRule.nested!);
					}
				}

				return out;
			}

			if (primitiveRule.nested) {
				const elem = parseRuleToJsonData(primitiveRule.nested);

				for (let i = 0, l = primitiveRule.length || 1; i < l; ++i) {
					out.push(elem);
				}
			}

			return out;
		}

		default:
			return null;
	}
}

function parseBody(bodyRule: ValidationRule | undefined, bodyType: BodyType | undefined, commentsInJson: boolean): undefined | string | Formdata[] {
	if (!bodyRule) {
		return;
	}

	switch (bodyType) {
		case 'json': {
			const jsonData = JSON.stringify(parseRuleToJsonData(bodyRule), null, '\t');

			if (commentsInJson) {
				return `${jsonData}
/*
${inspect(!Array.isArray(bodyRule) && bodyRule && bodyRule.type === 'object' && bodyRule.schema && !bodyRule.nested ? bodyRule.schema : bodyRule, true)}
*/`;
			}

			return jsonData;
		}

		case 'multipart': {
			const primitiveBodyRule = Array.isArray(bodyRule) ? bodyRule[0] : bodyRule;
			const body = primitiveBodyRule?.type === 'object' ? primitiveBodyRule.schema : undefined;

			if (!body) {
				return;
			}

			const out: Formdata[] = [];
			out.push(
				...Object
					.keys(body)
					.map((key) => {
						const rule = (Array.isArray(body[key]) ? (body[key] as PrimitiveRule[])[0]! : body[key]) as PrimitiveRule;

						if (rule.type === 'object') {
							return { type: 'file', key, src: null, description: inspect(body[key]) } as Formdata;
						}

						return { type: 'text', key, value: parseQueryRule(rule), description: inspect(body[key]) } as Formdata;
					}),
			);

			return out;
		}

		default:
			return;
	}
}

function buildItems(endpoints: BuiltEndpoint[], options: BuildCollectionOptions): (FolderItem | Item)[] {
	const out: (FolderItem | Item)[] = [];

	for (const e of endpoints) {
		let item: (FolderItem | Item)[] = out;
		const location = parseLocation(e.path, e.param, e.paramOrder, options.maxFolders);
		const query = parseQuery(e.query);
		const bodyData = parseBody(e.bodyRule, e.bodyType, options.commentsInJson!);

		for (const f of location.folders) {
			const prevItem = item;
			item = (item.find((fi) => fi.name === f) as FolderItem)?.item as FolderItem[];

			if (!item) {
				prevItem.push({ name: f, item: [] });
				item = (prevItem[prevItem.length - 1] as FolderItem).item as FolderItem[];
			}
		}

		let body: any;

		if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) && bodyData) {
			body = typeof bodyData === 'string' ? {
				mode: 'raw',
				raw: bodyData,
			} : {
				mode: 'formdata',
				formdata: bodyData,
			};
		}

		item.push({
			name: location.url.substring(location.host[0].length),
			request: {
				method: e.method,
				header: body?.mode === 'raw' ? [{ key: 'Content-Type', value: 'application/json' }] : [],
				body,
				url: { raw: location.url, host: location.host, path: location.path, variable: location.variable, query },
				auth: options.authorization ? options.authorization(e) : undefined,
			},
			response: [],
		});
	}

	return out;
}

export function buildCollection(name: string, endpoints: BuiltEndpoint[], options: BuildCollectionOptions = {}): PostmanCollectionSchema {
	options.commentsInJson ??= true;
	options.maxFolders ??= 2;

	const collectionSchema: PostmanCollectionSchema = {
		info: {
			name,
			schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
		},
		item: [],
	};

	collectionSchema.item = buildItems(endpoints, options);

	return collectionSchema;
}

export interface BuildCollectionOptions {

	/**
	 * Allow comments in JSON request data
	 * @default true
	 */
	commentsInJson?: boolean;

	/**
	 * Max folders
	 * @default 2
	 */
	maxFolders?: number;
	authorization?(endpoint: BuiltEndpoint): Auth | undefined;
}

export interface FolderItem {
	name: string;
	item: (FolderItem | Item)[];
}

export interface Variable {
	key: string;
	value: string;
	description?: string;
}

export interface Query {
	key: string;
	value: string;
	description?: string;
}

export type Formdata = {
	type: 'file';
	key: string;
	src: null;
	description?: string;
} | {
	type: 'text';
	key: string;
	value: string;
	description?: string;
};

export interface Item {
	name: string;
	request: {
		method: HttpMethod;
		header: {
			key: string;
			value: string;
			description?: string;
		}[];
		body?: {
			mode: 'raw';
			raw: string;
		} | {
			mode: 'formdata';
			formdata: Formdata[];
		};
		url: {
			raw: string;
			host: string[];
			path: string[];
			variable?: Variable[];
			query?: Query[];
		};
		auth?: Auth;
	};
	response: any[];
}

export interface Auth {
	type: 'bearer';
	bearer: {
		key: 'token';
		value: string;
		type: 'string';
	}[];
}

export interface PostmanCollectionSchema {
	info: {
		name: string;
		schema: string;
		_postman_id?: string;
	};
	item: (FolderItem | Item)[];
}
