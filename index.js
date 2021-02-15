const pMap = require('p-map')
const axios = require('axios')
const camelCase = require('camelcase')
const { mapKeys, isPlainObject, trimEnd, trimStart } = require('lodash')

const Fs = require('fs')
const Path = require('path')

const TYPE_AUTHOR = 'author'
const TYPE_ATTACHEMENT = 'attachment'

const TEMP_DIR = '.temp'
const DOWNLOAD_DIR = 'wp-images'

class WordPressSource {
  static defaultOptions() {
    return {
      baseUrl: '',
      apiBase: 'wp-json',
      perPage: 100,
      concurrent: 10,
      typeName: 'WordPress'
    }
  }

  constructor(api, options) {
    this.options = options
    this.restBases = { posts: {}, taxonomies: {} }

    if (!options.typeName) {
      throw new Error(`Missing typeName option.`)
    }

    if (options.perPage > 100 || options.perPage < 1) {
      throw new Error(`${options.typeName}: perPage cannot be more than 100 or less than 1.`)
    }

    this.customEndpoints = this.sanitizeCustomEndpoints()

    const baseUrl = trimEnd(options.baseUrl, '/')

    this.client = axios.create({
      baseURL: `${baseUrl}/${options.apiBase}`
    })

    this.routes = this.options.routes || {}

    /* Create image directories */
    //mkdirSyncRecursive(Path.resolve(DOWNLOAD_DIR))
    mkdirSyncRecursive(Path.resolve(TEMP_DIR))

    api.loadSource(async actions => {
      this.store = actions

      console.log(`Loading data from ${baseUrl}/${options.apiBase}`)

      await this.getPostTypes(actions)
      await this.getUsers(actions)
      await this.getTaxonomies(actions)
      await this.getPosts(actions)
      await this.getCustomEndpoints(actions)
    })
  }

  async getPostTypes(actions) {
    const { data } = await this.fetch('wp/v2/types', {}, {})
    const addCollection = actions.addCollection || actions.addContentType

    for (const type in data) {
      const options = data[type]

      this.restBases.posts[type] = trimStart(options.rest_base, '/')

      addCollection({
        typeName: this.createTypeName(type),
        route: this.routes[type]
      })
    }
  }

  async getUsers(actions) {
    const { data } = await this.fetch('wp/v2/users')
    const addCollection = actions.addCollection || actions.addContentType

    const authors = addCollection({
      typeName: this.createTypeName(TYPE_AUTHOR),
      route: this.routes.author
    })

    for (const author of data) {
      const fields = this.normalizeFields(author)
      const avatars = mapKeys(author.avatar_urls, (v, key) => `avatar${key}`)

      authors.addNode({
        ...fields,
        id: author.id,
        title: author.name,
        avatars
      })
    }
  }

  async getTaxonomies(actions) {
    const { data } = await this.fetch('wp/v2/taxonomies', {}, {})
    const addCollection = actions.addCollection || actions.addContentType

    for (const type in data) {
      const options = data[type]
      const taxonomy = addCollection({
        typeName: this.createTypeName(type),
        route: this.routes[type]
      })

      this.restBases.taxonomies[type] = trimStart(options.rest_base, '/')

      const terms = await this.fetchPaged(`wp/v2/${options.rest_base}`)

      for (const term of terms) {
        taxonomy.addNode({
          id: term.id,
          title: term.name,
          slug: term.slug,
          content: term.description,
          meta: term.meta,
          count: term.count
        })
      }
    }
  }

  async getPosts(actions) {
    const { createReference } = actions
    const getCollection = actions.getCollection || actions.getContentType

    const AUTHOR_TYPE_NAME = this.createTypeName(TYPE_AUTHOR)
    const ATTACHEMENT_TYPE_NAME = this.createTypeName(TYPE_ATTACHEMENT)

    for (const type in this.restBases.posts) {
      const restBase = this.restBases.posts[type]
      const typeName = this.createTypeName(type)
      const posts = getCollection(typeName)

      const data = await this.fetchPaged(`wp/v2/${restBase}`)

      for (const post of data) {
        const fields = this.normalizeFields(post)

        fields.author = createReference(AUTHOR_TYPE_NAME, post.author || '0')

        console.log(" ")
        console.log("post title: " + fields.title);

        if (post.type !== TYPE_ATTACHEMENT) {
          console.log("post featured media: ");
          fields.featuredMedia = createReference(ATTACHEMENT_TYPE_NAME, post.featured_media)

          //console.log("featured media: " + fields.featuredMedia.id);

          const mediaSize = "full"
          const media = await this.getMedia(fields.featuredMedia.id)

          let imageData = {};

          if (media !== undefined) {
            imageData = {
              sourceUrl: media.sizes["full"].source_url,
              altText: media.alt_text,
              mediaDetails: {
                width: media.width,
                height: media.height,
                file: media.file,
                sizes: {
                  full: {
                    sourceUrl: "/global/blog/" + media.sizes["full"].file,
                    width: media.sizes["full"].width,
                    height: media.sizes["full"].height
                  },
                  medium: {
                    sourceUrl: "/global/blog/" + media.sizes["medium"].file,
                    width: media.sizes["medium"].width,
                    height: media.sizes["medium"].height,
                  },
                  thumbnail: {
                    sourceUrl: "/global/blog/" + media.sizes["thumbnail"].file,
                    width: media.sizes["thumbnail"].width,
                    height: media.sizes["thumbnail"].height,
                  }

                }
              }
            }

            console.log("- file: "+media.file)
          } else {
            imageData = null
          }
          fields.featuredMedia = imageData

          this.downloadMedia(media, "full")
          this.downloadMedia(media, "medium")
          this.downloadMedia(media, "thumbnail")
        }

        // add references if post has any taxonomy rest bases as properties
        for (const type in this.restBases.taxonomies) {
          const propName = this.restBases.taxonomies[type]

          if (post.hasOwnProperty(propName)) {
            const typeName = this.createTypeName(type)
            const key = camelCase(propName)

            fields[key] = Array.isArray(post[propName])
              ? post[propName].map(id => createReference(typeName, id))
              : createReference(typeName, post[propName])


          }
        }

        posts.addNode({ ...fields, id: post.id })

      }
    }
  }

  async getCustomEndpoints(actions) {
    for (const endpoint of this.customEndpoints) {
      const makeCollection = actions.addCollection || actions.addContentType
      const cepCollection = makeCollection({
        typeName: endpoint.typeName
      })
      const { data } = await this.fetch(endpoint.route, {}, {})
      for (let item of data) {
        if (endpoint.normalize) {
          item = this.normalizeFields(item)
        }

        cepCollection.addNode({
          ...item,
          id: item.id || item.slug
        })
      }
    }
  }

  async fetch(url, params = {}, fallbackData = []) {
    let res

    try {
      res = await this.client.request({ url, params })
    } catch ({ response, code, config }) {
      if (!response && code) {
        throw new Error(`${code} - ${config.url}`)
      }

      if ([401, 403].includes(response.status)) {
        console.warn(`Error: Status ${response.status} - ${config.url}`)
        return { ...response, data: fallbackData }
      } else {
        //throw new Error(`${response.status} - ${config.url}`)
        throw new Error(`${response.status}`)
      }
    }

    return res
  }

  async fetchPaged(path) {
    const { perPage, concurrent } = this.options

    return new Promise(async (resolve, reject) => {
      let res

      try {
        res = await this.fetch(path, { per_page: perPage })
      } catch (err) {
        return reject(err)
      }

      const totalItems = parseInt(res.headers['x-wp-total'], 10)
      const totalPages = parseInt(res.headers['x-wp-totalpages'], 10)

      try {
        res.data = ensureArrayData(path, res.data)
      } catch (err) {
        return reject(err)
      }

      if (!totalItems || totalPages <= 1) {
        return resolve(res.data)
      }

      const queue = []

      for (let page = 2; page <= totalPages; page++) {
        queue.push({ per_page: perPage, page })
      }

      await pMap(queue, async params => {
        try {
          const { data } = await this.fetch(path, params)
          res.data.push(...ensureArrayData(path, data))
        } catch (err) {
          console.log(err.message)
        }
      }, { concurrency: concurrent })

      resolve(res.data)
    })
  }

  // @size: medium, thumbnail or full
  async getMedia(id, size = "full") {
    const response = await this.fetch(`wp/v2/media/${id}`).catch(err => {
      // what now?
      switch (err.message) {
        case "404":
          console.log("Error: 404 - Media file not found.")
          break;
        default:
          console.log(err)
      }

    })

    const r = {}

    if (response !== undefined && response.hasOwnProperty("data") === true) {

      for (const media in response.data) {

        if (media === "alt_text") {
          r.alt_text = response.data[media]
        }

        if (media === "media_details") {
          r.sizes = response.data[media].sizes
          r.width = response.data[media].width
          r.height = response.data[media].height
          r.file = response.data[media].file
        }

      }

      return r
    }

  }

  async downloadMedia(media, size = "full") {

    if (media !== undefined && media.hasOwnProperty("sizes") === true) {

      const img_path = Path.resolve(__dirname, '..', '..', '..', 'static', 'global', 'blog')
      const path = Path.resolve(img_path, media.sizes[size].file)
      const writer = Fs.createWriteStream(path)

      //console.log("path: " + path)
      //console.log("source_url: " + media.sizes[size].source_url)

      const response = await axios({
        url: media.sizes[size].source_url,
        method: 'GET',
        responseType: 'stream'
      }).catch(err => {
        // what now?
        switch (err.message) {
          case "404":
            console.log("Error: 404 - Media file not found.")
            break;
          default:
            console.log(err)
        }
      })
      //console.log(" ")

      response.data.pipe(writer)

      return new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
      })
    }
  }

  sanitizeCustomEndpoints() {
    if (!this.options.customEndpoints) return []
    if (!Array.isArray(this.options.customEndpoints)) throw Error('customEndpoints must be an array')
    this.options.customEndpoints.forEach(endpoint => {
      if (!endpoint.typeName) {
        throw Error('Please provide a typeName option for all customEndpoints\n')
      }
      if (!endpoint.route) {
        throw Error(`No route option in endpoint: ${endpoint.typeName}\n Ex: 'apiName/versionNumber/endpointObject'`)
      }
    })
    return this.options.customEndpoints ? this.options.customEndpoints : []
  }

  normalizeFields(fields) {
    const res = {}

    for (const key in fields) {
      if (key.startsWith('_')) continue // skip links and embeds etc
      res[camelCase(key)] = this.normalizeFieldValue(fields[key])
    }

    return res
  }

  normalizeFieldValue(value) {
    if (value === null) return null
    if (value === undefined) return null

    if (Array.isArray(value)) {
      return value.map(v => this.normalizeFieldValue(v))
    }

    if (isPlainObject(value)) {
      if (value.post_type && (value.ID || value.id)) {
        const typeName = this.createTypeName(value.post_type)
        const id = value.ID || value.id

        return this.store.createReference(typeName, id)
      } else if (value.filename && (value.ID || value.id)) {
        const typeName = this.createTypeName(TYPE_ATTACHEMENT)
        const id = value.ID || value.id

        return this.store.createReference(typeName, id)
      } else if (value.hasOwnProperty('rendered')) {
        return value.rendered
      }

      return this.normalizeFields(value)
    }

    return value
  }

  createTypeName(name = '') {
    return camelCase(`${this.options.typeName} ${name}`, { pascalCase: true })
  }
}

function ensureArrayData(url, data) {
  if (!Array.isArray(data)) {
    try {
      data = JSON.parse(data)
    } catch (err) {
      throw new Error(
        `Failed to fetch ${url}\n` +
        `Expected JSON response but received:\n` +
        `${data.trim().substring(0, 150)}...\n`
      )
    }
  }
  return data
}

function mkdirSyncRecursive(absDirectory) {
  const paths = absDirectory.replace(/\/$/, '').split('/')
  paths.splice(0, 1)

  let dirPath = '/'
  paths.forEach(segment => {
    dirPath += segment + '/'
    if (!Fs.existsSync(dirPath)) Fs.mkdirSync(dirPath)
  })
}

module.exports = WordPressSource