import _ from 'lodash'
import {K8sClient} from './k8sClient'
import K8sFunctions, { GetItemsFunction } from '../k8s/k8sFunctions'
import { ServiceDetails } from './k8sObjectTypes'
import {matchObjects} from '../util/matchUtil'

export default class IstioFunctions {

  private static extractResource(result: any, ...specKeys) {
    const yaml = specKeys.includes("yaml")
    const getResource = (obj) => {
      const resource = {
        ...K8sFunctions.extractMetadata(obj)
      }
      specKeys.forEach(key => obj.spec[key] && (resource[key] = obj.spec[key]))
      if(yaml) {
        delete obj.metadata["creationTimestamp"]
        delete obj.metadata["generation"]
        delete obj.metadata["resourceVersion"]
        delete obj.metadata["selfLink"]
        delete obj.metadata["uid"]
        resource["yaml"] = obj
      }
      return resource
    }
    if(result && result.body) {
      if(result.body.items) {
        return result.body.items.map(getResource)
      } else {
        return getResource(result.body)
      }
    }
    return []
  }

  static listAllGateways = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const keys = ["selector", "servers"]
    yaml && keys.push("yaml")
    return IstioFunctions.extractResource(await k8sClient.istio.gateways.get(), ...keys) as any[]
  }

  static listAllIngressGateways = async (k8sClient: K8sClient, yaml: boolean = true) => {
    return (await IstioFunctions.listAllGateways(k8sClient, yaml) as any[])
            .filter(gateway => gateway.selector.istio === 'ingressgateway')
  }

  static listAllEgressGateways = async (k8sClient: K8sClient, yaml: boolean = true) => {
    return (await IstioFunctions.listAllGateways(k8sClient, yaml) as any[])
            .filter(gateway => gateway.selector.istio === 'egressgateway')
  }

  static getGatewaysForVirtualServices = async (virtualServices: any[], k8sClient: K8sClient, yaml: boolean = false) => {
    const allGateways = await IstioFunctions.listAllGateways(k8sClient, yaml)
    return allGateways.filter(g => 
      virtualServices.filter(vs => vs.gateways)
      .filter(vs => 
        vs.gateways.filter(vsg => vsg === g.name || vsg.includes(g.name+".")).length > 0
      ).length > 0
    )
  }

  static getGatewaysForPorts = async (ports: number[], k8sClient: K8sClient) => {
    const allGateways = await IstioFunctions.listAllGateways(k8sClient, false)
    return allGateways.filter(g => g.servers.filter(s => ports.includes(s.port.number)).length > 0)
  }

  static getNamespaceGateways = async (namespace: string, k8sClient: K8sClient) => {
    const allGateways = await IstioFunctions.listAllGateways(k8sClient, true)
    return allGateways.filter(g => g.namespace === namespace)
  }

  static listAllVirtualServices = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const keys = ["gateways", "hosts", "http", "tls", "tcp"]
    yaml && keys.push("yaml")
    return IstioFunctions.extractResource(await k8sClient.istio.virtualservices.get(), ...keys) as any[]
  }

  static listAllIngressVirtualServices = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const ingressGateways = (await IstioFunctions.listAllIngressGateways(k8sClient))
                            .map(g => g.name)
    return (await IstioFunctions.listAllVirtualServices(k8sClient, yaml))
            .filter(v => v.gateways && v.gateways.filter(g => 
              ingressGateways.filter(ig => g === ig || g.includes(ig+".")).length > 0).length > 0)
  }

  static listAllEgressVirtualServices = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const egressGateways = (await IstioFunctions.listAllEgressGateways(k8sClient))
                            .map(g => g.name)
    return (await IstioFunctions.listAllVirtualServices(k8sClient, yaml))
            .filter(v => v.gateways && v.gateways.filter(g => egressGateways.includes(g)).length > 0)
  }

  static getVirtualServices = async (cluster, namespace, k8sClient) => {
    if(k8sClient.istio) {
      const virtualServices = (namespace && namespace.length > 0) ?
                                await k8sClient.istio.namespaces(namespace).virtualservices.get()
                                : await k8sClient.istio.virtualservices.get()
      return IstioFunctions.extractResource(virtualServices,
                              "gateways", "hosts", "http", "tls", "tcp") as any[]
    } else {
      return []
    }
  }

  static filterVirtualServicesByRouteForService(virtualServices: any[], 
                      service: string, namespace: string, routeType: string) {
    const serviceHost = service + "." + namespace
    return virtualServices.filter(vs => vs[routeType] ?
      vs[routeType].filter(routeType => 
        routeType.route.filter(route => {
          const textToMatch = vs.namespace === namespace ? service : serviceHost
          return route.destination.host.includes(textToMatch)
                && (route.destination.host.length === textToMatch.length ||
                    route.destination.host.includes(textToMatch+"."))
        }).length > 0
      ).length > 0
      : false
    )
  }

  static getVirtualServicesForService = async (service: string, namespace: string, k8sClient: K8sClient) => {
    const serviceHost = service + "." + namespace
    const allVirtualServices = await IstioFunctions.listAllVirtualServices(k8sClient)
    let httpVirtualServices = IstioFunctions.filterVirtualServicesByRouteForService(
                                allVirtualServices, service, namespace, 'http')
    let tlsVirtualServices = IstioFunctions.filterVirtualServicesByRouteForService(
                                allVirtualServices, service, namespace, 'tls')
    let tcpVirtualServices = IstioFunctions.filterVirtualServicesByRouteForService(
                                allVirtualServices, service, namespace, 'tcp')
    const virtualServices : {[key: string]: any} = {}
    httpVirtualServices.forEach(vs => virtualServices[vs.name]=vs)
    tlsVirtualServices.forEach(vs => virtualServices[vs.name]=vs)
    tcpVirtualServices.forEach(vs => virtualServices[vs.name]=vs)
    return Object.values(virtualServices)
  }

  static getVirtualServicesForPorts = async (ports: number[], k8sClient: K8sClient) => {
    const allVirtualServices = await IstioFunctions.listAllVirtualServices(k8sClient, false)
    return allVirtualServices.filter(vs => {
      const routeConfigs: any[] = []
      vs.http && vs.http.forEach(r => routeConfigs.push(r))
      vs.tls && vs.tls.forEach(r => routeConfigs.push(r))
      vs.tcp && vs.tcp.forEach(r => routeConfigs.push(r))
      return routeConfigs.filter(rc => rc.match && rc.match.filter(m => ports.includes(m.port)).length > 0).length > 0
      ||
      routeConfigs.filter(rc => rc.route && rc.route.filter(r => 
        r.destination && r.destination.port && ports.includes(r.destination.port.number)).length > 0).length > 0
    })
  }

  static getNamespaceVirtualServices = async (namespace: string, k8sClient: K8sClient) => {
    const allVirtualServices = await IstioFunctions.listAllVirtualServices(k8sClient, true)
    return allVirtualServices.filter(vs => vs.namespace === namespace)
  }

  static listAllSidecarResources = async (k8sClient: K8sClient) => {
    if(k8sClient.istio.sidecars) {
      return IstioFunctions.extractResource(await k8sClient.istio.sidecars.get(), 
                      "workloadSelector", "ingress", "egress", "yaml") as any[]
    } else {
      return []
    }
  }

  static getNamespaceSidecarResources = async (namespace: string, k8sClient: K8sClient) => {
    if(k8sClient.istio.sidecars) {
      return (IstioFunctions.extractResource(await k8sClient.istio.sidecars.get(), 
                      "workloadSelector", "ingress", "egress", "yaml") as any[])
            .filter(sc => sc.namespace === namespace)
    } else {
      return []
    }
  }

  static getServiceEgressSidecarResources = async (service: ServiceDetails, k8sClient: K8sClient) => {
    const allSidecarResources = await IstioFunctions.listAllSidecarResources(k8sClient)
    const nsSidecarResources = allSidecarResources.filter(sc => sc.namespace === service.namespace)
    const serviceSidecarResources = nsSidecarResources.filter(sc => 
      sc.workloadSelector && sc.workloadSelector.labels 
      && matchObjects(sc.workloadSelector.labels, service.selector))
    if(serviceSidecarResources.length > 0) {
      return serviceSidecarResources
    } else {
      return nsSidecarResources.filter(sc => !sc.workloadSelector)
    }
  }

  static getServiceIncomingSidecarResources = async (service: ServiceDetails, k8sClient: K8sClient) => {
    const allSidecarResources = await IstioFunctions.listAllSidecarResources(k8sClient)
    return allSidecarResources.filter(sc => 
      sc.egress && sc.egress.filter(e => e.hosts && e.hosts.filter(host => 
        host === "*/*" 
        || host === service.namespace+"/*"
        || host === service.name+"."+service.namespace+".svc.cluster.local").length > 0).length > 0)
  }

  static listAllDestinationRules = async (k8sClient: K8sClient) => {
    return IstioFunctions.extractResource(await k8sClient.istio.destinationrules.get(), "yaml") as any[]
  }

  static extractDestinationRules(result) {
    return IstioFunctions.extractResource(result, "host", "trafficPolicy", "subsets", "exportTo") as any[]
  }

  static getServiceDestinationRules = async (service: ServiceDetails, k8sClient: K8sClient) => {
    const allDestinationRules = IstioFunctions.extractDestinationRules(await k8sClient.istio.destinationrules.get())
    const applicableDestinationRules = allDestinationRules.filter(r => 
            r.host === service.name
            || r.host.includes(service.name+"."+service.namespace)
            || r.host === "*."+service.namespace
            || r.host.includes("*."+service.namespace+".")
            || r.host.includes("*.local")
          )
    return applicableDestinationRules
  }

  static getClientNamespaceDestinationRules = async (namespace: string, k8sClient: K8sClient) => {
    const allDestinationRules = IstioFunctions.extractDestinationRules(await k8sClient.istio.destinationrules.get())
    return allDestinationRules.filter(r => r.namespace === namespace)
  }

  static getNamespaceDestinationRules = async (namespace: string, k8sClient: K8sClient) => {
    const allDestinationRules = await IstioFunctions.listAllDestinationRules(k8sClient)
    return allDestinationRules.filter(r => r.namespace === namespace)
  }

  static listAllServiceEntries = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const fields = ["hosts", "addresses", "ports", "location", "resolution", "endpoints"]
    yaml && fields.push("yaml")
    return IstioFunctions.extractResource(await k8sClient.istio.serviceentries.get(), ...fields) as any[]
  }

  static getNamespaceServiceEntries = async (namespace: string, k8sClient: K8sClient) => {
    return (await IstioFunctions.listAllServiceEntries(k8sClient))
            .filter(se => se.namespace === namespace)
  }

  static getServiceServiceEntries = async (service: ServiceDetails, k8sClient: K8sClient) => {
    const allServiceEntries = await IstioFunctions.listAllServiceEntries(k8sClient, false)
    return allServiceEntries.filter(se => 
      se.hosts && se.hosts.filter(host => host.includes(service.name+"."+service.namespace)).length > 0
      || se.endpoints && se.endpoints.filter(e => e.address.includes(service.name+"."+service.namespace)).length > 0
    )
  }

  static listAllEnvoyFilters = async (k8sClient: K8sClient) => {
    return IstioFunctions.extractResource(await k8sClient.istio.envoyfilters.get(),
                                "workloadLabels", "filters", "yaml") as any[]
  }

  static listAllPolicies = async (k8sClient: K8sClient, yaml: boolean = true) => {
    const fields = ["targets", "peers", "peerIsOptional", "origins", 
                    "originIsOptional", "principalBinding"]
    yaml && fields.push("yaml")
    return IstioFunctions.extractResource(await k8sClient.istio.policies.get(), ...fields) as any[]
  }

  static getServicePolicies = async (service: ServiceDetails, k8sClient: K8sClient) => {
    const allPolicies = await IstioFunctions.listAllPolicies(k8sClient, false)
    return allPolicies.filter(p => 
      (p.name === "default" && p.namespace === service.namespace && !p.targets)
      || 
      (p.targets && p.targets.filter(target => 
          target.name === service.name || target.name.includes(service+".")).length > 0)
    )
  }

  static getNamespacePolicies = async (namespace: string, k8sClient: K8sClient) => {
    const allPolicies = await IstioFunctions.listAllPolicies(k8sClient, true)
    return allPolicies.filter(p => p.namespace === namespace)
  }

  static listAllMeshPolicies = async (k8sClient: K8sClient) => {
    return IstioFunctions.extractResource(await k8sClient.istio.meshpolicies.get(),
            "targets", "peers", "peerIsOptional", "origins", 
            "originIsOptional", "principalBinding", "yaml") as any[]
  }

  static listAllRules = async (k8sClient: K8sClient) => {
    return IstioFunctions.extractResource(await k8sClient.istio.rules.get(),
                                "match", "actions", "yaml") as any[]
  }

  static getNamespaceRules = async (namespace: string, k8sClient: K8sClient) => {
    const allRules = await IstioFunctions.listAllRules(k8sClient)
    return allRules.filter(r => r.namespace === namespace)
  }

  static listAnyResource = async (resource: string, k8sClient: K8sClient) => {
    if(k8sClient.crds[resource]) {
      return IstioFunctions.extractResource(await k8sClient.crds[resource].get(), "yaml") as any[]
    }
    return []
  }

  static async getIstioServiceDetails(labelSelector: string, k8sClient: K8sClient) {
    const services = await K8sFunctions.getServicesByLabels("istio-system", labelSelector, k8sClient)
    return services.map(service => {
      return {
        name: service.name,
        type: service.type,
        clusterIP: service.clusterIP,
        externalIPs: service.externalIPs,
        externalName: service.externalName,
        healthCheckNodePort: service.healthCheckNodePort,
        'loadBalancer.ingress': service.loadBalancer?service.loadBalancer.ingress:"",
        loadBalancerIP: service.loadBalancerIP,
        loadBalancerSourceRanges: service.loadBalancerSourceRanges,
        ports: service.ports.map(port => "["+port.name+", "+port.protocol+", "
                  +(port.nodePort?port.nodePort+"->":"")
                  +(port.port?port.port:"")
                  +(port.targetPort?"->"+port.targetPort:"")
                  +"]"),
        selector: service.selector,
        yaml: service.yaml,
    }})
  }

  static async getIstioServicePods(labelSelector: string, k8sClient: K8sClient, loadDetails: boolean = false) {
    const ingressPods = await K8sFunctions.getPodsByLabels("istio-system", labelSelector, k8sClient)
    return ingressPods.map(pod => {
      return {
        name: pod.name,
        podIP: pod.podIP,
        hostIP: pod.hostIP,
        startTime: pod.startTime,
        conditions: pod.conditions,
        podDetails: loadDetails ? pod : undefined
      }
    })
  }

  static async getIngressGatewayPods(k8sClient: K8sClient, loadDetails: boolean = false) {
    return IstioFunctions.getIstioServicePods("istio=ingressgateway", k8sClient, loadDetails)
  }

  static async getPilotPods(k8sClient: K8sClient, loadDetails: boolean = false) {
    return IstioFunctions.getIstioServicePods("istio=pilot", k8sClient, loadDetails)
  }

  static getIngressCertsFromPod = async (pod: string, k8sClient: K8sClient) => {
    let commandOutput: any = (await K8sFunctions.podExec("istio-system", pod, "istio-proxy", k8sClient, 
                                  ["curl", "-s", "127.0.0.1:15000/certs"])).trim()
    try {
      commandOutput = JSON.parse(commandOutput)
    } catch(error) {
      commandOutput = commandOutput.replace(/}/g, "},")
      commandOutput = commandOutput.slice(0, commandOutput.lastIndexOf(","))
      commandOutput = "[" + commandOutput + "]"
      commandOutput = JSON.parse(commandOutput)
    }
    if(commandOutput.map) {
      return commandOutput
    } else if(commandOutput.certificates) {
      return commandOutput.certificates
    }
    return []
  }

  static getIngressCerts = async (k8sClient: K8sClient) => {
    const ingressPods = await IstioFunctions.getIngressGatewayPods(k8sClient)
    if(!ingressPods || ingressPods.length === 0) {
      console.log("IngressGateway not found")
      return []
    }
    return IstioFunctions.getIngressCertsFromPod(ingressPods[0].name, k8sClient)
  }

  static async getIstioProxyConfigDump(k8sClient: K8sClient, namespace: string, pod: string, configType?: string) {
    try {
      const result = JSON.parse(await K8sFunctions.podExec(namespace, pod, "istio-proxy", k8sClient, 
                                  ["curl", "-s", "http://127.0.0.1:15000/config_dump"]))
      if(result.configs.clusters) {
        result.configs = Object.values(result.configs)
      }
      let configs = result.configs
      if(configType) {
        configs = configs.filter(c => c["@type"].includes(configType))[0]
      }
      if(configType) {
        const dynamicItems = configs[Object.keys(configs).filter(key => key.includes("dynamic"))[0]]
        const staticItems = configs[Object.keys(configs).filter(key => key.includes("static"))[0]]
        const items: any[] = []
        staticItems && staticItems.forEach(item => item && items.push(item))
        dynamicItems && dynamicItems.forEach(item => item && items.push(item))
        return items
      } else {
        return configs
      }
    } catch(error) {
      console.log(error)
    }
    return []
  }

  static async getIstioProxyStats(k8sClient: K8sClient, namespace: string, pod: string) {
      return K8sFunctions.podExec(namespace, pod, "istio-proxy", k8sClient, 
                                  ["curl", "-s", "http://127.0.0.1:15000/stats"])
  }

  static async getIngressListenerPorts(k8sClient: K8sClient) {
    const ingressPods = await IstioFunctions.getIngressGatewayPods(k8sClient)
    if(!ingressPods || ingressPods.length === 0) {
      console.log("IngressGateway not found")
      return []
    }
    const ingressPodListenersMap = {}
    for(const ingressPod of ingressPods) {
      const listeners = JSON.parse(await K8sFunctions.podExec("istio-system", ingressPod.name, "istio-proxy", k8sClient, 
                                  ["curl", "-s", "http://127.0.0.1:15000/listeners"]))
      ingressPodListenersMap[ingressPod.name] = listeners.map(l => l.split(":")[1])
                        .filter(p => p).map(p => parseInt(p))
    }
    return ingressPodListenersMap
  }

  static async getIngressConfigDump(k8sClient: K8sClient, configType?: string) {
    const ingressPods = await IstioFunctions.getIngressGatewayPods(k8sClient)
    if(!ingressPods || ingressPods.length === 0) {
      console.log("IngressGateway not found")
      return []
    }
    return IstioFunctions.getIstioProxyConfigDump(k8sClient, "istio-system", ingressPods[0].name, configType)
  }

  static async getIngressGatwayStats(k8sClient: K8sClient) {
    const ingressPods = await IstioFunctions.getIngressGatewayPods(k8sClient)
    if(!ingressPods || ingressPods.length === 0) {
      console.log("IngressGateway not found")
      return ""
    }
    return IstioFunctions.getIstioProxyStats(k8sClient, "istio-system", ingressPods[0].name)
  }

  static async executeOnAnyPilotPod(k8sClient: K8sClient, command: string[]) {
    const pilotPods = await IstioFunctions.getPilotPods(k8sClient)
    return K8sFunctions.podExec("istio-system", pilotPods[0].name, "discovery", k8sClient, command)
  }

  static async getPilotEndpoints(k8sClient: K8sClient, service?: string, namespace?: string) {
    if(!k8sClient.istio) {
      return []
    }
    const result = await IstioFunctions.executeOnAnyPilotPod(k8sClient,
                                  ["curl", "-s", "localhost:8080/debug/edsz"])
    if(result) {
      let pilotEndpoints = JSON.parse(result) as any[]
      if(service && namespace) {
        const text = service + "." + namespace
        pilotEndpoints = pilotEndpoints.filter(e => e.clusterName.includes(text))
      }
      return pilotEndpoints
    }
    return []

  }

  static async getPilotMetrics(k8sClient: K8sClient) {
    if(!k8sClient.istio) {
      return undefined
    }
    return IstioFunctions.executeOnAnyPilotPod(k8sClient,
                                  ["curl", "-s", "localhost:8080/metrics"])
  }

  static async getPilotSidecarSyncStatus(k8sClient: K8sClient) {
    if(!k8sClient.istio) {
      return []
    }
    const result = await IstioFunctions.executeOnAnyPilotPod(k8sClient,
                                  ["curl", "-s", "localhost:8080/debug/syncz"])
    return result ? JSON.parse(result) as any[] : []
  }

  static async getPilotConfigDump(k8sClient: K8sClient, proxyID: string, configType?: string) {
    try {

      const result = JSON.parse(await IstioFunctions.executeOnAnyPilotPod(k8sClient,
                                    ["curl", "-s", "localhost:8080/debug/config_dump?proxyID="+proxyID]))
      let configs = result.configs
      if(configType) {
        configs = configs.filter(c => c["@type"].includes(configType))
      }
      configs = configs.map(config => {
        if(configType) {
          return config[Object.keys(config).filter(key => key.includes("dynamic"))[0]]
        } else {
          return config
        }
      })
      return configType ? configs[0] : configs
    } catch(error) {
      console.log(error)
    }
    return []
  }

  static getAllSidecars = async (k8sClient: K8sClient) => {
    if(!k8sClient.istio) {
      return []
    }
    const result = await IstioFunctions.executeOnAnyPilotPod(k8sClient,
                                  ["curl", "-s", "localhost:8080/debug/adsz"])
    if(result) {
      const pilotCDSData = JSON.parse(result) as any[]
      const sidecars = pilotCDSData.filter(cds => cds.node.startsWith("sidecar~"))
                          .map(cds => cds.node.split("~"))
                          .map(pieces => {
                            const podAndNamespace = pieces[2].split(".")
                            return {
                              ip: pieces[1],
                              pod: podAndNamespace[0],
                              namespace: podAndNamespace[1]
                            }
                          })
      return sidecars
    }
    return []
  }

  static getNamespaceSidecars = async (namespace: string, k8sClient: K8sClient) => {
    const sidecars = await IstioFunctions.getAllSidecars(k8sClient)
    return sidecars.filter(s => s.namespace === namespace)
  }
}
