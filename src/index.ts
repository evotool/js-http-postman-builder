import { BodyType, BuiltEndpoint, HttpMethod } from '@evojs/http';
import { HttpClient } from '@evojs/http-client';
import { ParamSchema } from '@evojs/http/decorators/Endpoint';
import { ObjectRule, PrimitiveRule, ValidationRule, ValidationSchema } from '@evojs/validator';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve as pathResolve } from 'path';
import { inspect } from 'util';

export class HttpPostmanBuilder {
	protected readonly _http: HttpClient;
	protected readonly _collectionSchema: PostmanCollectionSchema = { info: { name: '', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] };
	protected readonly _environmentSchema: PostmanEnvironmentSchema = { name: '', values: [] };

	constructor(protected readonly _options: PostmanBuilderOptions, protected _logger?: Logger) {
		if (!_options.apiKeys) {
			_options.apiKeys = [];
		}

		if (!_logger) {
			_options.debug = false;
		}

		this._collectionSchema.info.name = _options.name;
		this._environmentSchema.name = _options.name;
		this._environmentSchema.values.push(...Object.entries(_options.environments).map(([key, value]) => ({ key, value, enabled: true })));
		this._http = new HttpClient(_logger && (_logger.name ? _logger.name('http') : _logger));
		this._http.setUrl('https://api.getpostman.com/');

		const { collection, environment } = _options.files;

		mkdirSync(dirname(pathResolve(collection)), { recursive: true });
		mkdirSync(dirname(pathResolve(environment)), { recursive: true });
	}

	addEndpoints(endpoints: BuiltEndpoint[]): void {
		if (this._options.debug) {
			this._logger!.debug('start generate');
		}

		for (const e of endpoints) {
			let item: (FolderItem | Item)[] = this._collectionSchema.item as FolderItem[];
			const location = this._parseLocation(e.path, e.param, e.paramOrder);
			const query = this._parseQuery(e.query);
			const bodyData = this._parseBody(e.body, e.bodyType) || '{}';

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
					header: [{ key: 'Content-Type', value: 'application/json' }],
					body,
					url: { raw: location.url, host: location.host, path: location.path, variable: location.variable, query },
					auth: this._options.authorization ? this._options.authorization(e) : undefined,
				},
				response: [],
			});
		}

		if (this._options.debug) {
			this._logger!.debug('end generate');
		}
	}

	generate(): boolean {
		const { collection, environment } = this._options.files;

		if (!this._collectionChanged(collection)) {
			return false;
		}

		this._writeToFile(collection, this._collectionSchema);
		this._writeToFile(environment, this._environmentSchema);

		return true;
	}

	async generateAndSend(): Promise<boolean> {
		if (!this.generate()) {
			return false;
		}

		const collectionSchema = { ...this._collectionSchema, info: { ...this._collectionSchema.info } };

		collectionSchema.info.name += ` ${new Date().toISOString().substring(0, 19).replace('T', ' ')}`;

		await Promise.all(
			this._options.apiKeys!
				.map(
					(x) => this._http
						.post(`collections`, { headers: { 'X-Api-Key': x }, body: { collection: collectionSchema } })
						.then((res) => res.body()),
				),
		);

		return true;
	}

	protected _writeToFile(filename: string, data: object): void {
		writeFileSync(filename, this._stringifyJson(data), 'utf-8');
	}

	protected _collectionChanged(collectionFilename: string): boolean {
		return !existsSync(collectionFilename) || readFileSync(collectionFilename, 'utf-8') !== this._stringifyJson(this._collectionSchema);
	}

	protected _stringifyJson(object: any): string {
		return JSON.stringify(object, null, '\t');
	}

	protected _parseBody(body: ValidationSchema | undefined, bodyType: BodyType | undefined): undefined | string | Formdata[] {
		if (body) {
			switch (bodyType) {
				case 'json': {
					const out = Object.keys(body).reduce((p, n) => Object.assign(p, { [n]: this._parseRuleToJsonc(body[n]) }), {});

					return this._stringifyJsonc([out]);
				}

				case 'multipart': {
					const out: Formdata[] = [];
					out.push(
						...Object
							.keys(body)
							.map((key) => {
								const rule = (Array.isArray(body[key]) ? (body[key] as PrimitiveRule[])[0]! : body[key]) as PrimitiveRule;

								if (rule.type === 'object') {
									return { type: 'file', key, src: null, description: this._parseDescription(body[key]) } as Formdata;
								}

								return { type: 'text', key, value: this._parseQueryRule(rule), description: this._parseDescription(body[key]) } as Formdata;
							}),
					);

					return out;
				}

				default:
					break;
			}
		}
	}

	protected _stringifyJsonc(data: JsoncData, last: boolean = true, indent: number = 0): string {
		indent += 1;

		const value = data[0];
		const comment = (last ? '' : ',') + (data[1] ? ` // ${data[1]}\n` : '\n');

		switch (typeof value) {
			case 'string':
				return `"${value}"${comment}`;
			case 'number':
			case 'boolean':
				return `${value}${comment}`;
			case 'object':
			{
				if (value === null) {
					return `null${comment}`;
				}

				const endIndent = '\t'.repeat(indent - 1);
				const valuesIndent = '\t'.repeat(indent);

				if (Array.isArray(value)) {
					const lastIndex = value.length - 1;

					return `[\n${value.map((v, i) => `${valuesIndent}${this._stringifyJsonc(v, lastIndex === i, indent)}`).join('')}${endIndent}]${comment}`;
				}

				const entries = Object.entries(value);
				const lastIndex = entries.length - 1;

				return `{\n${entries.map(([k, v], i) => `${valuesIndent}"${k}": ${this._stringifyJsonc(v, lastIndex === i, indent)}`).join('')}${endIndent}}${comment}`;
			}

			default:
				break;
		}

		return '';
	}

	protected _parseRuleToJsonc(validationRule: ValidationRule): JsoncData {
		const out: JsoncData = [null];
		out[1] = this._parseDescription(validationRule);

		const rule = Array.isArray(validationRule) ? validationRule[0] : validationRule;

		if (rule) {
			if (typeof rule.default !== 'undefined' && typeof rule.default !== 'function') {
				out[0] = rule.default;
			} else {
				switch (rule.type) {
					case 'boolean':
						out[0] = false;

						break;
					case 'string':
						out[0] = rule.values ? rule.values[0] || '' : '';

						break;
					case 'number':
						{
							const v = rule.values ? rule.values[0] : undefined;
							out[0] = isFinite(v!) ? v! : 0;
						}

						break;
					case 'array':
						if ((rule.nested && !Array.isArray(rule.nested) && rule.nested.type !== 'array' && rule.nested.type !== 'object') || Array.isArray(rule.nested)) {
							out[0] = Array(rule.length || 1).fill(null).map(() => this._parseRuleToJsonc(rule.nested!));
						} else {
							out[0] = [];
						}

						break;
					case 'object':
						if (rule.schema) {
							out[0] = Object.fromEntries(Object.keys(rule.schema).map((key) => [key, this._parseRuleToJsonc(rule.schema![key])]));
						} else {
							out[0] = {};
						}

						break;
					default:
						break;
				}
			}
		}

		return out;
	}

	protected _parseQuery(query?: ValidationSchema): Query[] {
		const out: Query[] = [];

		if (query) {
			out.push(...Object.keys(query).map((key) => {
				const rule = (Array.isArray(query[key]) ? (query[key] as PrimitiveRule[])[0]! : query[key]) as PrimitiveRule;
				const description: string | undefined = this._parseDescription(query[key]);

				return { key, value: this._parseQueryRule(rule), description };
			}));
		}

		return out;
	}

	protected _parseQueryRule(rule: PrimitiveRule): string {
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

	protected _parseDescription(data: ValidationRule): string | undefined {
		if (data) {
			if (Array.isArray(data)) {
				const rules = data.map((d) => {
					if (d.type !== 'object' && d.type !== 'array') {
						return;
					}

					if (d.nested && !Array.isArray(d.nested) && d.nested.type !== 'object' && d.nested.type !== 'array') {
						return this._inspect(d);
					}

					const { nested, schema, ...croppedData } = d as ObjectRule;

					return this._inspect(croppedData);
				}).filter(Boolean);

				if (rules.length) {
					return this._inspect(rules);
				}

				return;
			}

			if (
				(
					data.type !== 'object'
					&& data.type !== 'array'
				) || (
					data.nested
					&& !Array.isArray(data.nested)
					&& data.nested.type !== 'object'
					&& data.nested.type !== 'array'
				)
			) {
				return this._inspect(data);
			}

			const { nested, schema, ...croppedData } = data as ObjectRule;

			return this._inspect(croppedData);
		}
	}

	protected _parseLocation(
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
			variable.push({ key, value: '', description: inspect(param[key], false, null, false) });
		}

		const url = `{{host}}/${path}`;
		const host = ['{{host}}'];

		return { folders, url, host, path: path.split('/'), variable };
	}

	protected _keyLength(object: { [key: string]: any }): number {
		let count = 0;

		for (const p in object) {
			if (!object.hasOwnProperty(p) || object[p] === undefined) {
				continue;
			}

			count++;
		}

		return count;
	}

	protected _inspect(object: { [key: string]: any }): string | undefined {
		if (this._keyLength(object) === 0) {
			return;
		}

		object = { ...object };

		for (const p in object) {
			if (!object.hasOwnProperty(p) || object[p] !== undefined) {
				continue;
			}

			delete object[p];
		}

		return inspect(object, false, null, false).replace(/\n+ */g, ' ').trim();
	}
}

export type JsoncData = [string | number | boolean | null | {
	[key: string]: JsoncData;
} | JsoncData[], string?];

export interface PostmanBuilderOptions {
	name: string;
	files: {
		collection: string;
		environment: string;
	};
	environments: {
		host: string;
		accessKey: string;
		[key: string]: string;
	};
	authorization?(endpoint: BuiltEndpoint): Auth | undefined;
	apiKeys?: string[];
	debug?: boolean;
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

export interface PostmanEnvironmentSchema {
	id?: string;
	name: string;
	values: {
		key: string;
		value: string;
		enabled: boolean;
	}[];
}

export interface Logger {
	debug(...args: any[]): void;
	name?(name: string): Logger;
}
